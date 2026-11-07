#!/usr/bin/env python3
"""PostgreSQL and object-storage backup, verification and restore tooling.

The tool is intentionally standalone: it depends on the PostgreSQL client
binaries, Python 3.11+, and (only when object storage is enabled) boto3. It does
not import the API service, so it can run from a dedicated backup image.

Artifacts are self-describing directories:

    <backup-dir>/artifacts/<run-id>/
        manifest.json
        postgres.dump[.gpg]
        objects.tar.gz[.gpg]

Every payload is checksummed in the manifest. When a passphrase is configured,
payloads are encrypted with GPG AES-256 and the manifest records that fact but
never the key. Verification decrypts and validates the archives.

Safety properties:
  * an advisory file lock prevents overlapping backup runs;
  * artifacts are assembled in a temporary directory and moved into place only
    after verification;
  * retention never removes the minimum number of verified artifacts or the
    most recent one;
  * restores require an explicit target database confirmation and refuse the
    configured source database;
  * logs and manifests never contain passwords, passphrases or object content.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import re
import secrets
import select
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

TOOL_VERSION = "1.0.0"
MANIFEST_VERSION = 1
DEFAULT_BACKUP_DIR = "/backup"
_SAFE_IDENTIFIER = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")
_RUN_ID_RE = re.compile(r"^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$")
_REQUIRED_EXTENSIONS = ("vector", "citext", "pg_trgm")
_CRITICAL_TABLES = (
    "schema_migrations",
    "knowledge_sources",
    "documents",
    "document_chunks",
    "embeddings",
    "assistant_conversations",
    "assistant_messages",
    "agents",
    "agent_versions",
    "executions",
    "events",
    "event_deliveries",
    "jobs",
)


class BackupError(RuntimeError):
    """Operational failure with a stable, non-sensitive error code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime | None) -> str | None:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z") if value else None


def _log(event: str, **fields: Any) -> None:
    record = {"ts": _iso(_utc_now()), "event": event, **fields}
    print(json.dumps(record, sort_keys=True), file=sys.stderr)


def _redact(value: str, secrets_: list[str]) -> str:
    result = value
    for secret in secrets_:
        if secret:
            result = result.replace(secret, "[redacted]")
    return result


def _sha256_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


@dataclass(frozen=True)
class PgConn:
    host: str
    port: int
    database: str
    user: str
    password: str = field(repr=False, default="")
    sslmode: str = "prefer"

    def env(self) -> dict[str, str]:
        env = os.environ.copy()
        if self.password:
            env["PGPASSWORD"] = self.password
        env["PGSSLMODE"] = self.sslmode
        env["PGCONNECT_TIMEOUT"] = env.get("PGCONNECT_TIMEOUT", "10")
        # pg_dump/pg_restore must see every tenant row. The custom setting is
        # transaction-local in the application but PGOPTIONS applies it to the
        # trusted maintenance sessions started by this tool. Never expose this
        # option to API or worker processes.
        existing = env.get("PGOPTIONS", "").strip()
        env["PGOPTIONS"] = (
            f"{existing} -c ai.system_access=on".strip()
            if existing
            else "-c ai.system_access=on"
        )
        return env

    def base_args(self) -> list[str]:
        return [
            "-h",
            self.host,
            "-p",
            str(self.port),
            "-U",
            self.user,
            "-d",
            self.database,
        ]


@dataclass(frozen=True)
class BackupConfig:
    backup_dir: Path
    pg: PgConn
    schema: str
    scope: str
    s3_endpoint: str
    s3_region: str
    s3_bucket: str
    s3_access_key_id: str = field(repr=False, default="")
    s3_secret_access_key: str = field(repr=False, default="")
    s3_force_path_style: bool = True
    object_prefix: str = ""
    backup_objects: bool = True
    passphrase: str = field(repr=False, default="")
    require_encryption: bool = False
    retention_days: int = 14
    retention_min_count: int = 3
    pg_restore_bin: str = "pg_restore"
    pg_dump_bin: str = "pg_dump"
    psql_bin: str = "psql"
    gpg_bin: str = "gpg"
    role_profile: str = ""
    expected_role: str = ""

    @property
    def artifacts_dir(self) -> Path:
        return self.backup_dir / "artifacts"

    @property
    def temp_dir(self) -> Path:
        return self.backup_dir / "tmp"

    @property
    def drill_dir(self) -> Path:
        return self.backup_dir / "restore-drills"

    @property
    def lock_path(self) -> Path:
        return self.backup_dir / ".backup.lock"

    @property
    def encrypted(self) -> bool:
        return bool(self.passphrase)

    @classmethod
    def from_env(cls) -> BackupConfig:
        backup_dir = Path(os.environ.get("BACKUP_DIR", DEFAULT_BACKUP_DIR)).expanduser()
        schema = os.environ.get("AI_DB_SCHEMA", "ai")
        if not _SAFE_IDENTIFIER.fullmatch(schema):
            raise BackupError("invalid_schema", "AI_DB_SCHEMA is not a safe identifier")
        scope = os.environ.get("BACKUP_DATABASE_SCOPE", "schema").strip().lower()
        if scope not in {"schema", "database"}:
            raise BackupError("invalid_scope", "BACKUP_DATABASE_SCOPE must be schema or database")
        password = os.environ.get("POSTGRES_PASSWORD", os.environ.get("PGPASSWORD", ""))
        pg = PgConn(
            host=os.environ.get("POSTGRES_HOST", "127.0.0.1"),
            port=int(os.environ.get("POSTGRES_PORT", "5432")),
            database=os.environ.get("POSTGRES_DB", "helix"),
            user=os.environ.get("POSTGRES_USER", "helix"),
            password=password,
            sslmode=os.environ.get("POSTGRES_SSLMODE", "prefer"),
        )
        passphrase = os.environ.get("BACKUP_ENCRYPTION_PASSPHRASE", "")
        passphrase_file = os.environ.get("BACKUP_ENCRYPTION_PASSPHRASE_FILE", "")
        if passphrase_file:
            try:
                passphrase = Path(passphrase_file).read_text(encoding="utf-8").strip()
            except OSError as exc:
                raise BackupError(
                    "encryption_key_unavailable", "cannot read BACKUP_ENCRYPTION_PASSPHRASE_FILE"
                ) from exc
        retention_days = int(os.environ.get("BACKUP_RETENTION_DAYS", "14"))
        retention_min = int(os.environ.get("BACKUP_RETENTION_MIN_COUNT", "3"))
        if retention_days < 1 or retention_min < 1:
            raise BackupError("invalid_retention", "retention values must be positive")
        return cls(
            backup_dir=backup_dir,
            pg=pg,
            schema=schema,
            scope=scope,
            s3_endpoint=os.environ.get("S3_ENDPOINT", "http://127.0.0.1:8333"),
            s3_region=os.environ.get("S3_REGION", "us-east-1"),
            s3_bucket=os.environ.get("S3_BUCKET", "ai-knowledge"),
            s3_access_key_id=os.environ.get("S3_ACCESS_KEY_ID", ""),
            s3_secret_access_key=os.environ.get("S3_SECRET_ACCESS_KEY", ""),
            s3_force_path_style=_env_bool("S3_FORCE_PATH_STYLE", True),
            object_prefix=os.environ.get("BACKUP_OBJECT_PREFIX", ""),
            backup_objects=_env_bool("BACKUP_OBJECTS", True),
            passphrase=passphrase,
            require_encryption=_env_bool("BACKUP_REQUIRE_ENCRYPTION", False),
            retention_days=retention_days,
            retention_min_count=retention_min,
            pg_restore_bin=os.environ.get("PG_RESTORE_BIN", "pg_restore"),
            pg_dump_bin=os.environ.get("PG_DUMP_BIN", "pg_dump"),
            psql_bin=os.environ.get("PSQL_BIN", "psql"),
            gpg_bin=os.environ.get("GPG_BIN", "gpg"),
            role_profile=os.environ.get("AI_DB_ROLE_PROFILE", "").strip().lower(),
            expected_role=os.environ.get("AI_DB_EXPECTED_ROLE", "").strip(),
        )

    def validate(self) -> None:
        if self.require_encryption and not self.encrypted:
            raise BackupError(
                "encryption_required",
                "BACKUP_REQUIRE_ENCRYPTION is set but no encryption passphrase is configured",
            )
        required = [self.pg_dump_bin, self.pg_restore_bin, self.psql_bin]
        if self.encrypted:
            required.append(self.gpg_bin)
        for binary in required:
            if shutil.which(binary) is None:
                raise BackupError("missing_tool", f"required executable not found: {binary}")
        try:
            self.backup_dir.mkdir(parents=True, exist_ok=True)
            for directory in (self.artifacts_dir, self.temp_dir, self.drill_dir):
                directory.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise BackupError("backup_dir_unavailable", "backup directory is not writable") from exc
        if self.backup_objects and not self.s3_bucket:
            raise BackupError("missing_config", "S3_BUCKET is required for object backups")


def _run(
    args: list[str],
    *,
    env: dict[str, str] | None = None,
    input_text: str | None = None,
    timeout: int = 300,
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            args,
            env=env,
            input=input_text,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise BackupError("command_timeout", f"command timed out: {Path(args[0]).name}") from exc
    except OSError as exc:
        raise BackupError("command_failed", f"cannot execute {Path(args[0]).name}") from exc


def _run_checked(
    args: list[str],
    *,
    env: dict[str, str] | None = None,
    input_text: str | None = None,
    timeout: int = 300,
    secrets_: list[str] | None = None,
) -> str:
    result = _run(args, env=env, input_text=input_text, timeout=timeout)
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "").strip()
        message = _redact(message, secrets_ or [])[:2000]
        raise BackupError("command_failed", message or f"{Path(args[0]).name} failed")
    return result.stdout


def _psql(
    conn: PgConn,
    sql: str,
    *,
    cfg: BackupConfig | None = None,
    database: str | None = None,
    snapshot: str | None = None,
) -> str:
    args = [cfg.psql_bin if cfg else "psql", "-X", "-v", "ON_ERROR_STOP=1"]
    args.extend(conn.base_args())
    if database:
        args[-1] = database
    input_text = None
    if snapshot:
        if not re.fullmatch(r"[0-9A-Fa-f-]+", snapshot):
            raise BackupError("snapshot_invalid", "invalid exported snapshot identifier")
        input_text = (
            "BEGIN ISOLATION LEVEL REPEATABLE READ;\n"
            f"SET TRANSACTION SNAPSHOT '{snapshot}';\n"
            f"{sql}\n"
            "COMMIT;"
        )
        # psql suppresses command tags with -q only when reading a script from
        # stdin; -c would leak BEGIN/SET/COMMIT into the tuple output.
        args.extend(["-qAt", "-F", "\t", "-f", "-"])
    else:
        args.extend(["-At", "-F", "\t", "-c", sql])
    return _run_checked(
        args, env=conn.env(), secrets_=[conn.password], input_text=input_text
    )


_ROLE_STATE_SQL = """
SELECT current_user,
       r.rolsuper::text,
       r.rolcreatedb::text,
       r.rolcreaterole::text,
       r.rolbypassrls::text,
       COALESCE(
         pg_has_role(current_user, to_regrole('ai_system_access'), 'MEMBER'),
         false
       )::text,
       EXISTS (
         SELECT 1
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = '{schema}'
           AND c.relowner = r.oid
           AND c.relkind IN ('r', 'p')
       )::text
FROM pg_roles r
WHERE r.rolname = current_user;
"""


def _verify_restore_role(
    cfg: BackupConfig,
    target: PgConn,
    *,
    profile: str,
    expected: str | None,
    require_createdb: bool,
) -> None:
    """Verify a restore credential before the target database exists.

    The drill/restore target is created by the tool itself, so a check that
    connects to ``target.database`` would fail with "database does not exist"
    before any work happens. Role attributes live in the shared catalog, so
    probe through the maintenance database instead and never accept ownership
    of the source schema.
    """
    probe = replace(target, database="postgres")
    try:
        _verify_role(
            probe,
            cfg,
            profile=profile,
            expected=expected,
            require_createdb=require_createdb,
            allow_owns_ai_tables=False,
        )
    except BackupError as exc:
        if exc.code == "command_failed":
            raise BackupError(
                "restore_role_probe_failed",
                "cannot inspect the restore role through the maintenance "
                "database; the restore credential needs CONNECT on 'postgres'",
            ) from exc
        raise


def _role_state(conn: PgConn, cfg: BackupConfig, schema: str) -> dict[str, object]:
    if not _SAFE_IDENTIFIER.fullmatch(schema):
        raise BackupError("invalid_schema", "AI_DB_SCHEMA is not a safe identifier")
    output = _psql(conn, _ROLE_STATE_SQL.format(schema=schema), cfg=cfg).strip()
    fields = output.split("\t")
    if len(fields) != 7:
        raise BackupError("role_state_unavailable", "could not read database role state")
    return {
        "role_name": fields[0],
        "superuser": fields[1] == "true",
        "createdb": fields[2] == "true",
        "createrole": fields[3] == "true",
        "bypassrls": fields[4] == "true",
        "system_member": fields[5] == "true",
        "owns_ai_tables": fields[6] == "true",
    }


def _verify_role(
    conn: PgConn,
    cfg: BackupConfig,
    *,
    profile: str,
    expected: str | None,
    require_createdb: bool = False,
    allow_owns_ai_tables: bool | None = None,
) -> None:
    """Fail before backup/restore if the connected role is not least-privilege.

    ``allow_owns_ai_tables`` defaults to the historical behaviour (only the
    ``restore`` profile may own the tables of the schema it is connected to).
    Callers that probe the *source* database on behalf of a restore credential
    must pass ``False``: owning the source schema is never acceptable.
    """
    if profile not in {"api", "worker", "backup", "restore", "migrate"}:
        raise BackupError("invalid_role_profile", "unsupported database role profile")
    if allow_owns_ai_tables is None:
        allow_owns_ai_tables = profile == "restore"
    state = _role_state(conn, cfg, cfg.schema)
    reasons: list[str] = []
    if expected and state["role_name"] != expected:
        reasons.append("unexpected_role")
    if state["superuser"]:
        reasons.append("superuser")
    if state["bypassrls"]:
        reasons.append("bypassrls")
    # The isolated restore role owns objects it creates in the target database;
    # that is expected there. It must never own the source/production schema.
    if state["owns_ai_tables"] and not allow_owns_ai_tables:
        reasons.append("owns_ai_tables")
    if profile in {"api", "worker", "backup", "migrate"} and state["createdb"]:
        reasons.append("createdb_not_allowed")
    if profile != "restore" and state["createrole"]:
        reasons.append("createrole_not_allowed")
    if profile == "api" and state["system_member"]:
        reasons.append("api_system_member")
    if profile != "api" and not state["system_member"]:
        reasons.append("system_membership_missing")
    if require_createdb and not state["createdb"]:
        reasons.append("createdb_required")
    if reasons:
        _log(
            "backup.role_verification_failed",
            reason=",".join(reasons),
            role=str(state["role_name"]),
            profile=profile,
        )
        raise BackupError("unsafe_database_role", "database role is not permitted")


@contextlib.contextmanager
def _exported_snapshot(cfg: BackupConfig):
    """Hold a repeatable-read transaction open and export its snapshot.

    Metadata is read and ``pg_dump`` is run against this snapshot so the
    manifest counts and the dump describe the same database state even while
    the application is serving writes.
    """
    args = [
        cfg.psql_bin,
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        *cfg.pg.base_args(),
    ]
    proc = subprocess.Popen(
        args,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=cfg.pg.env(),
    )
    try:
        assert proc.stdin is not None and proc.stdout is not None
        proc.stdin.write(
            "BEGIN ISOLATION LEVEL REPEATABLE READ;\nSELECT pg_export_snapshot();\n"
        )
        proc.stdin.flush()
        ready, _, _ = select.select([proc.stdout], [], [], 15)
        if not ready:
            raise BackupError("snapshot_timeout", "timed out exporting a database snapshot")
        snapshot = proc.stdout.readline().strip()
        if not re.fullmatch(r"[0-9A-Fa-f-]+", snapshot):
            stderr = ""
            if proc.poll() is not None and proc.stderr is not None:
                stderr = _redact(proc.stderr.read(), [cfg.pg.password])[:500]
            raise BackupError(
                "snapshot_failed",
                stderr or "database did not export a repeatable-read snapshot",
            )
        yield snapshot
    finally:
        if proc.stdin is not None:
            with contextlib.suppress(OSError):
                proc.stdin.write("COMMIT;\n\\q\n")
                proc.stdin.flush()
                proc.stdin.close()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


def _quote_identifier(value: str) -> str:
    if not _SAFE_IDENTIFIER.fullmatch(value):
        raise BackupError("invalid_identifier", "unsafe SQL identifier")
    return '"' + value + '"'


def _source_dump_args(
    cfg: BackupConfig, output: Path, *, snapshot: str | None = None
) -> list[str]:
    args = [
        cfg.pg_dump_bin,
        "-h",
        cfg.pg.host,
        "-p",
        str(cfg.pg.port),
        "-U",
        cfg.pg.user,
        "-d",
        cfg.pg.database,
        "--format=custom",
        "--compress=6",
        "--no-owner",
        "--no-privileges",
        # FORCE RLS applies to the table owner too. pg_dump otherwise forces
        # row_security=off and aborts on any protected table; with this flag the
        # maintenance snapshot's ai.system_access setting can see every tenant.
        "--enable-row-security",
        "--file",
        str(output),
    ]
    if cfg.scope == "schema":
        args.extend(["--schema", cfg.schema])
    if snapshot:
        if not re.fullmatch(r"[0-9A-Fa-f-]+", snapshot):
            raise BackupError("snapshot_invalid", "invalid exported snapshot identifier")
        args.extend(["--snapshot", snapshot])
    return args


def _collect_database_metadata(cfg: BackupConfig, *, snapshot: str | None = None) -> dict[str, Any]:
    schema = _quote_identifier(cfg.schema)
    server_version = _psql(cfg.pg, "SHOW server_version;", cfg=cfg).strip()
    extension_rows = _psql(
        cfg.pg,
        "SELECT extname FROM pg_extension ORDER BY extname;",
        cfg=cfg,
        snapshot=snapshot,
    ).splitlines()
    tables = _psql(
        cfg.pg,
        "SELECT tablename FROM pg_tables WHERE schemaname = "
        + "'" + cfg.schema.replace("'", "''") + "' ORDER BY tablename;",
        cfg=cfg,
        snapshot=snapshot,
    ).splitlines()
    tables = [table for table in tables if _SAFE_IDENTIFIER.fullmatch(table)]
    if not tables:
        raise BackupError("empty_schema", "no tables found in the configured AI schema")
    migrations: list[dict[str, str]] = []
    if "schema_migrations" in tables:
        lines = _psql(
            cfg.pg,
            f"SELECT version, checksum FROM {schema}.schema_migrations ORDER BY version;",
            cfg=cfg,
            snapshot=snapshot,
        ).splitlines()
        for line in lines:
            version, _, checksum = line.partition("\t")
            migrations.append({"version": version, "checksum": checksum})
    counts_sql = " UNION ALL ".join(
        f"SELECT '{table}' AS table_name, count(*)::text AS row_count "
        f"FROM {schema}.{_quote_identifier(table)}"
        for table in tables
    )
    counts: dict[str, int] = {}
    for line in _psql(
        cfg.pg, counts_sql + ";", cfg=cfg, snapshot=snapshot
    ).splitlines():
        name, _, value = line.partition("\t")
        if name:
            counts[name] = int(value)
    tenant_tables = _psql(
        cfg.pg,
        "SELECT table_name FROM information_schema.columns WHERE table_schema = "
        + "'" + cfg.schema.replace("'", "''")
        + "' AND column_name = 'tenant_id' ORDER BY table_name;",
        cfg=cfg,
        snapshot=snapshot,
    ).splitlines()
    tenant_tables = [table for table in tenant_tables if table in counts]
    tenant_counts: dict[str, int] = {}
    if tenant_tables:
        tenant_sql = " UNION ALL ".join(
            f"SELECT '{table}' AS table_name, count(DISTINCT tenant_id)::text "
            f"FROM {schema}.{_quote_identifier(table)}"
            for table in tenant_tables
        )
        for line in _psql(
            cfg.pg, tenant_sql + ";", cfg=cfg, snapshot=snapshot
        ).splitlines():
            name, _, value = line.partition("\t")
            if name:
                tenant_counts[name] = int(value)
    document_object_keys: list[str] = []
    if "documents" in tables:
        key_sql = (
            f"SELECT object_key FROM {schema}.documents "
            "WHERE object_key IS NOT NULL ORDER BY object_key;"
        )
        document_object_keys = [
            line
            for line in _psql(cfg.pg, key_sql, cfg=cfg, snapshot=snapshot).splitlines()
            if line
        ]
    return {
        "server_version": server_version,
        "extensions": sorted(extension_rows),
        "migration_count": len(migrations),
        "migrations": migrations,
        "tables": tables,
        "table_counts": counts,
        "tenant_counts": tenant_counts,
        "document_object_keys_count": len(document_object_keys),
        "document_object_keys_sha256": hashlib.sha256(
            "\n".join(document_object_keys).encode("utf-8")
        ).hexdigest(),
    }


def _s3_client(cfg: BackupConfig, *, endpoint: str | None = None):
    try:
        import boto3
        from botocore import UNSIGNED
        from botocore.config import Config
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise BackupError("missing_dependency", "object backups require boto3") from exc
    access = cfg.s3_access_key_id
    secret = cfg.s3_secret_access_key
    unsigned = not access and not secret
    config = Config(
        signature_version=UNSIGNED if unsigned else None,
        s3={"addressing_style": "path"} if cfg.s3_force_path_style else {},
        retries={"max_attempts": 3, "mode": "standard"},
    )
    return boto3.session.Session().client(
        "s3",
        endpoint_url=endpoint or cfg.s3_endpoint,
        region_name=cfg.s3_region,
        aws_access_key_id=None if unsigned else access,
        aws_secret_access_key=None if unsigned else secret,
        config=config,
    )


def _backup_objects(cfg: BackupConfig, work_dir: Path, archive: Path) -> dict[str, Any]:
    client = _s3_client(cfg)
    blobs = work_dir / "blobs"
    blobs.mkdir(parents=True, exist_ok=True)
    index_path = work_dir / "index.jsonl"
    entries: list[dict[str, Any]] = []
    total_bytes = 0
    try:
        paginator = client.get_paginator("list_objects_v2")
        pages = paginator.paginate(Bucket=cfg.s3_bucket, Prefix=cfg.object_prefix)
        for page in pages:
            for item in page.get("Contents", []):
                key = item["Key"]
                response = client.get_object(Bucket=cfg.s3_bucket, Key=key)
                body = response["Body"]
                digest = hashlib.sha256()
                size = 0
                temp_blob = work_dir / f".download-{secrets.token_hex(8)}"
                try:
                    with temp_blob.open("wb") as handle:
                        while True:
                            chunk = body.read(1024 * 1024)
                            if not chunk:
                                break
                            digest.update(chunk)
                            handle.write(chunk)
                            size += len(chunk)
                finally:
                    with contextlib.suppress(Exception):
                        body.close()
                if size != int(item.get("Size", size)):
                    raise BackupError("object_size_mismatch", f"object size mismatch for {key}")
                sha = digest.hexdigest()
                blob_path = blobs / sha
                if blob_path.exists():
                    temp_blob.unlink()
                else:
                    os.replace(temp_blob, blob_path)
                entries.append(
                    {
                        "key": key,
                        "size": size,
                        "sha256": sha,
                        "etag": item.get("ETag", "").strip('"'),
                        "content_type": response.get("ContentType") or "application/octet-stream",
                        "last_modified": _iso(response.get("LastModified")),
                        "version_id": response.get("VersionId"),
                    }
                )
                total_bytes += size
    except BackupError:
        raise
    except Exception as exc:
        raise BackupError(
            "object_backup_failed",
            f"S3 object listing/download failed: {type(exc).__name__}",
        ) from exc
    entries.sort(key=lambda entry: entry["key"])
    with index_path.open("w", encoding="utf-8") as handle:
        for entry in entries:
            handle.write(json.dumps(entry, sort_keys=True, separators=(",", ":")) + "\n")
    with tarfile.open(archive, "w:gz", compresslevel=6) as tar:
        _tar_add_file(tar, index_path, "objects/index.jsonl", 0o644)
        for blob in sorted(blobs.iterdir()):
            if blob.is_file():
                _tar_add_file(tar, blob, f"objects/blobs/{blob.name}", 0o600)
    return {
        "enabled": True,
        "bucket": cfg.s3_bucket,
        "prefix": cfg.object_prefix,
        "count": len(entries),
        "bytes": total_bytes,
        "index_sha256": hashlib.sha256(index_path.read_bytes()).hexdigest(),
    }


def _tar_add_file(tar: tarfile.TarFile, path: Path, name: str, mode: int) -> None:
    info = tarfile.TarInfo(name)
    info.size = path.stat().st_size
    info.mode = mode
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    with path.open("rb") as handle:
        tar.addfile(info, handle)


def _extract_objects(archive: Path, destination: Path) -> Path:
    destination.mkdir(parents=True, exist_ok=True)
    try:
        with tarfile.open(archive, "r:gz") as tar:
            for member in tar.getmembers():
                parts = Path(member.name).parts
                if not member.isfile() or not parts or parts[0] != "objects" or ".." in parts:
                    raise BackupError(
                        "invalid_artifact", "object archive contains an unsafe member"
                    )
                target = destination.joinpath(*parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                source = tar.extractfile(member)
                if source is None:
                    raise BackupError("invalid_artifact", "object archive member is unreadable")
                with source, target.open("wb") as handle:
                    shutil.copyfileobj(source, handle)
    except BackupError:
        raise
    except (OSError, tarfile.TarError) as exc:
        raise BackupError("invalid_artifact", "object archive is corrupt") from exc
    index = destination / "objects" / "index.jsonl"
    if not index.is_file():
        raise BackupError("invalid_artifact", "object archive is missing index.jsonl")
    return index


@contextlib.contextmanager
def _gpg_environment():
    """Provide gpg with a writable, private home directory.

    gpg needs to create ``pubring.kbx``, a lock file and an agent socket under
    ``$GNUPGHOME`` (falling back to ``$HOME/.gnupg``). The backup image runs as
    an unprivileged user with a read-only root filesystem and no created home,
    so the default location is unwritable and gpg exits 2 before it encrypts
    anything. Point both variables at a fresh temporary directory.
    """
    home = Path(tempfile.mkdtemp(prefix="ai-gpg-"))
    home.chmod(0o700)
    try:
        env = os.environ.copy()
        env["GNUPGHOME"] = str(home)
        env["HOME"] = str(home)
        yield env
    finally:
        shutil.rmtree(home, ignore_errors=True)


def _encrypt_file(cfg: BackupConfig, path: Path) -> Path:
    output = path.with_name(path.name + ".gpg")
    with _gpg_environment() as env:
        result = _run(
            [
                cfg.gpg_bin,
                "--batch",
                "--yes",
                "--pinentry-mode",
                "loopback",
                "--passphrase-fd",
                "0",
                "--symmetric",
                "--cipher-algo",
                "AES256",
                "--output",
                str(output),
                str(path),
            ],
            env=env,
            input_text=cfg.passphrase,
            timeout=600,
        )
    if result.returncode != 0 or not output.is_file() or output.stat().st_size == 0:
        raise BackupError("encryption_failed", "GPG encryption failed")
    path.unlink()
    return output


def _decrypt_to_temp(cfg: BackupConfig, path: Path, suffix: str) -> Path:
    if not cfg.passphrase:
        raise BackupError("encryption_key_unavailable", "encrypted artifact requires a passphrase")
    handle, name = tempfile.mkstemp(prefix="ai-backup-", suffix=suffix)
    os.close(handle)
    temp = Path(name)
    with _gpg_environment() as env:
        result = _run(
            [
                cfg.gpg_bin,
                "--batch",
                "--yes",
                "--pinentry-mode",
                "loopback",
                "--passphrase-fd",
                "0",
                "--output",
                str(temp),
                "--decrypt",
                str(path),
            ],
            env=env,
            input_text=cfg.passphrase,
            timeout=900,
        )
    if result.returncode != 0 or not temp.is_file() or temp.stat().st_size == 0:
        with contextlib.suppress(OSError):
            temp.unlink()
        raise BackupError("decryption_failed", "GPG decryption failed")
    temp.chmod(0o600)
    return temp


def _materialize_dump(cfg: BackupConfig, artifact_dir: Path, manifest: dict[str, Any]) -> Path:
    entry = _file_entry(manifest, "postgres.dump", "postgres.dump.gpg")
    path = artifact_dir / entry["name"]
    if entry.get("encrypted"):
        return _decrypt_to_temp(cfg, path, ".dump")
    return path


def _file_entry(manifest: dict[str, Any], *names: str) -> dict[str, Any]:
    for entry in manifest.get("files", []):
        if entry.get("name") in names:
            return entry
    raise BackupError("invalid_artifact", "required payload is not listed in the manifest")


def _verify_checksums(artifact_dir: Path, manifest: dict[str, Any]) -> None:
    for entry in manifest.get("files", []):
        name = entry.get("name") or ""
        if not name or Path(name).name != name:
            raise BackupError("invalid_artifact", "artifact contains an unsafe file name")
        path = artifact_dir / name
        if not path.is_file():
            raise BackupError("artifact_incomplete", f"missing artifact payload: {name}")
        digest, size = _sha256_file(path)
        if size != int(entry.get("size", -1)):
            raise BackupError("artifact_corrupt", f"size mismatch for {name}")
        if digest != entry.get("sha256"):
            raise BackupError("artifact_corrupt", f"checksum mismatch for {name}")


def verify_artifact(cfg: BackupConfig, artifact_dir: Path, *, deep: bool = True) -> dict[str, Any]:
    manifest_path = artifact_dir / "manifest.json"
    if not manifest_path.is_file():
        raise BackupError("artifact_incomplete", "manifest.json is missing")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BackupError("artifact_invalid", "manifest.json is not valid JSON") from exc
    if manifest.get("manifest_version") != MANIFEST_VERSION:
        raise BackupError("artifact_invalid", "unsupported manifest version")
    if manifest.get("kind") != "backup" or manifest.get("status") != "succeeded":
        raise BackupError("artifact_invalid", "manifest does not describe a successful backup")
    _verify_checksums(artifact_dir, manifest)
    checks = ["manifest", "checksums"]
    dump_entry = _file_entry(manifest, "postgres.dump", "postgres.dump.gpg")
    if dump_entry.get("encrypted") and not cfg.passphrase:
        raise BackupError("encryption_key_unavailable", "encrypted artifact requires a passphrase")
    dump_path = _materialize_dump(cfg, artifact_dir, manifest)
    try:
        if deep:
            listing = _run_checked(
                [cfg.pg_restore_bin, "--list", str(dump_path)],
                env=os.environ.copy(),
                timeout=300,
                secrets_=[cfg.passphrase],
            )
            if "TABLE DATA" not in listing and cfg.scope == "schema":
                raise BackupError("artifact_invalid", "custom dump contains no table data")
            checks.append("pg_restore_list")
    finally:
        if dump_entry.get("encrypted") and dump_path.exists():
            dump_path.unlink()
    object_entry = next(
        (
            entry
            for entry in manifest.get("files", [])
            if entry.get("name", "").startswith("objects.tar.gz")
        ),
        None,
    )
    if object_entry:
        object_path = artifact_dir / object_entry["name"]
        extracted: Path | None = None
        if object_entry.get("encrypted"):
            extracted = _decrypt_to_temp(cfg, object_path, ".tar.gz")
            object_path = extracted
        try:
            with tempfile.TemporaryDirectory(prefix="ai-backup-objects-") as temp:
                _extract_objects(object_path, Path(temp))
            checks.append("object_archive")
        finally:
            if extracted and extracted.exists():
                extracted.unlink()
    return {
        "run_id": manifest["run_id"],
        "created_at": manifest["created_at"],
        "checks": checks,
        "encrypted": bool(manifest.get("encryption", {}).get("enabled")),
        "artifact_size_bytes": int(manifest.get("artifact_size_bytes", 0)),
    }


def _acquire_lock(cfg: BackupConfig, run_id: str) -> int:
    fd = os.open(cfg.lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as exc:
        os.close(fd)
        raise BackupError("backup_locked", "another backup run is already in progress") from exc
    os.ftruncate(fd, 0)
    os.write(fd, f"{run_id} {os.getpid()} {_iso(_utc_now())}\n".encode())
    os.fsync(fd)
    return fd


def _release_lock(fd: int) -> None:
    with contextlib.suppress(OSError):
        fcntl.flock(fd, fcntl.LOCK_UN)
    with contextlib.suppress(OSError):
        os.close(fd)


def _record_run(
    cfg: BackupConfig,
    *,
    run_id: str,
    kind: str,
    status: str,
    started_at: datetime,
    finished_at: datetime | None,
    artifact_id: str | None,
    artifact_size: int | None,
    duration: float | None,
    checksum: str | None,
    encrypted: bool | None,
    integrity_ok: bool | None,
    details: dict[str, Any],
    error_code: str | None,
) -> bool:
    schema = _quote_identifier(cfg.schema)
    sql = f"""
INSERT INTO {schema}.backup_runs
  (run_id, kind, status, started_at, finished_at, artifact_id, artifact_size_bytes,
   duration_seconds, checksum, encrypted, integrity_ok, details, error_code)
VALUES
  (:'run_id', :'kind', :'status', NULLIF(:'started_at','')::timestamptz,
   NULLIF(:'finished_at','')::timestamptz, NULLIF(:'artifact_id',''),
   NULLIF(:'artifact_size','')::bigint, NULLIF(:'duration','')::double precision,
   NULLIF(:'checksum',''), NULLIF(:'encrypted','')::boolean,
   NULLIF(:'integrity_ok','')::boolean, :'details'::jsonb,
   NULLIF(:'error_code',''))
ON CONFLICT (run_id) DO UPDATE SET
  status = EXCLUDED.status,
  finished_at = EXCLUDED.finished_at,
  artifact_size_bytes = EXCLUDED.artifact_size_bytes,
  duration_seconds = EXCLUDED.duration_seconds,
  checksum = EXCLUDED.checksum,
  encrypted = EXCLUDED.encrypted,
  integrity_ok = EXCLUDED.integrity_ok,
  details = EXCLUDED.details,
  error_code = EXCLUDED.error_code;
""".strip()
    variables = {
        "run_id": run_id,
        "kind": kind,
        "status": status,
        "started_at": _iso(started_at) or "",
        "finished_at": _iso(finished_at) or "",
        "artifact_id": artifact_id or "",
        "artifact_size": "" if artifact_size is None else str(artifact_size),
        "duration": "" if duration is None else f"{duration:.3f}",
        "checksum": checksum or "",
        "encrypted": "" if encrypted is None else ("true" if encrypted else "false"),
        "integrity_ok": "" if integrity_ok is None else ("true" if integrity_ok else "false"),
        "details": json.dumps(details, sort_keys=True, separators=(",", ":")),
        "error_code": error_code or "",
    }
    args = [cfg.psql_bin, "-X", "-v", "ON_ERROR_STOP=1"]
    args.extend(cfg.pg.base_args())
    for key, value in variables.items():
        args.extend(["-v", f"{key}={value}"])
    args.extend(["-f", "-"])
    result = _run(args, env=cfg.pg.env(), input_text=sql, timeout=60)
    if result.returncode != 0:
        _log(
            "backup.record_failed",
            kind=kind,
            status=status,
            detail=_redact(
                (result.stderr or result.stdout or "").strip()[-500:],
                [cfg.pg.password],
            ),
        )
        return False
    return True


def _manifest_digest(files: list[dict[str, Any]]) -> str:
    payload = "\n".join(f"{entry['name']}:{entry['sha256']}:{entry['size']}" for entry in files)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    path.chmod(0o644)


def _latest_artifact(cfg: BackupConfig) -> Path:
    candidates: list[tuple[str, Path]] = []
    for path in cfg.artifacts_dir.iterdir():
        manifest_path = path / "manifest.json"
        if not path.is_dir() or not manifest_path.is_file():
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if manifest.get("kind") == "backup" and manifest.get("status") == "succeeded":
            candidates.append((str(manifest.get("created_at", "")), path))
    if not candidates:
        raise BackupError("artifact_not_found", "no successful backup artifact was found")
    return max(candidates)[1]


def _resolve_artifact(cfg: BackupConfig, value: str | None) -> Path:
    if value:
        candidate = Path(value).expanduser()
        if candidate.is_dir():
            return candidate.resolve()
        if _RUN_ID_RE.fullmatch(value):
            candidate = cfg.artifacts_dir / value
            if candidate.is_dir():
                return candidate
        raise BackupError("artifact_not_found", "the requested artifact does not exist")
    return _latest_artifact(cfg)


def _apply_retention(cfg: BackupConfig, *, now: datetime | None = None) -> list[str]:
    entries: list[tuple[datetime, Path]] = []
    for path in cfg.artifacts_dir.iterdir():
        manifest_path = path / "manifest.json"
        if not path.is_dir() or not manifest_path.is_file():
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            created = datetime.fromisoformat(str(manifest["created_at"]))
        except (OSError, ValueError, KeyError, json.JSONDecodeError):
            continue
        if manifest.get("kind") == "backup" and manifest.get("status") == "succeeded":
            entries.append((created, path))
    entries.sort()
    if len(entries) <= cfg.retention_min_count:
        return []
    keep = {path for _, path in entries[-cfg.retention_min_count :]}
    cutoff = (now or _utc_now()) - timedelta(days=cfg.retention_days)
    deleted: list[str] = []
    for created, path in entries:
        if path in keep or created >= cutoff:
            continue
        try:
            shutil.rmtree(path)
            deleted.append(path.name)
        except OSError:
            _log("backup.retention_failed", artifact=path.name)
    return deleted


def _artifact_files(artifact_dir: Path) -> list[dict[str, Any]]:
    files: list[dict[str, Any]] = []
    for path in sorted(artifact_dir.iterdir()):
        if path.name == "manifest.json" or not path.is_file():
            continue
        digest, size = _sha256_file(path)
        files.append(
            {
                "name": path.name,
                "sha256": digest,
                "size": size,
                "encrypted": path.name.endswith(".gpg"),
            }
        )
    return files


def create_backup(cfg: BackupConfig) -> dict[str, Any]:
    cfg.validate()
    run_id = f"{_utc_now():%Y%m%dT%H%M%SZ}-{secrets.token_hex(3)}"
    started_at = _utc_now()
    lock_fd = _acquire_lock(cfg, run_id)
    temp_artifact = cfg.temp_dir / run_id
    final_artifact = cfg.artifacts_dir / run_id
    manifest: dict[str, Any] | None = None
    details: dict[str, Any] = {"scope": cfg.scope, "schema": cfg.schema}
    try:
        if final_artifact.exists():
            raise BackupError("artifact_conflict", "artifact identifier already exists")
        temp_artifact.mkdir(parents=True, exist_ok=False)
        dump_path = temp_artifact / "postgres.dump"
        # Metadata and pg_dump share one exported repeatable-read snapshot, so
        # a live application cannot make the manifest disagree with the dump.
        with _exported_snapshot(cfg) as snapshot:
            metadata = _collect_database_metadata(cfg, snapshot=snapshot)
            details.update(
                {
                    "tables": len(metadata["tables"]),
                    "migration_count": metadata["migration_count"],
                }
            )
            _run_checked(
                _source_dump_args(cfg, dump_path, snapshot=snapshot),
                env=cfg.pg.env(),
                timeout=3600,
                secrets_=[cfg.pg.password],
            )
        if not dump_path.is_file() or dump_path.stat().st_size == 0:
            raise BackupError("dump_empty", "pg_dump produced an empty file")
        listing = _run_checked(
            [cfg.pg_restore_bin, "--list", str(dump_path)],
            env=os.environ.copy(),
            timeout=300,
        )
        if "TABLE DATA" not in listing:
            raise BackupError("dump_incomplete", "custom dump contains no table data")
        object_metadata: dict[str, Any] = {"enabled": False}
        if cfg.backup_objects:
            objects_work = temp_artifact / "objects-work"
            objects_work.mkdir()
            object_metadata = _backup_objects(cfg, objects_work, temp_artifact / "objects.tar.gz")
            shutil.rmtree(objects_work)
            details.update(
                {
                    "objects": object_metadata["count"],
                    "object_bytes": object_metadata["bytes"],
                }
            )
        payloads = [
            path
            for path in (temp_artifact / "postgres.dump", temp_artifact / "objects.tar.gz")
            if path.exists()
        ]
        if cfg.encrypted:
            for path in payloads:
                _encrypt_file(cfg, path)
        files = _artifact_files(temp_artifact)
        artifact_size = sum(int(entry["size"]) for entry in files)
        created_at = _utc_now()
        manifest = {
            "manifest_version": MANIFEST_VERSION,
            "tool": "ai-backup",
            "tool_version": TOOL_VERSION,
            "run_id": run_id,
            "kind": "backup",
            "status": "succeeded",
            "created_at": _iso(created_at),
            "started_at": _iso(started_at),
            "finished_at": _iso(created_at),
            "database": metadata,
            "object_storage": object_metadata,
            "encryption": {
                "enabled": cfg.encrypted,
                "cipher": "AES256" if cfg.encrypted else "none",
            },
            "files": files,
            "checksum": _manifest_digest(files),
            "artifact_size_bytes": artifact_size,
            "restore": {
                "required_extensions": list(_REQUIRED_EXTENSIONS),
                "migrations_are_applied": True,
                "notes": [
                    "Restore into a clean database and pre-create the required extensions.",
                    "Do not run migrations automatically during a recovery.",
                ],
            },
            "retention": {
                "days": cfg.retention_days,
                "min_count": cfg.retention_min_count,
            },
        }
        _write_manifest(temp_artifact / "manifest.json", manifest)
        verify_artifact(cfg, temp_artifact)
        os.replace(temp_artifact, final_artifact)
    except Exception as exc:
        finished_at = _utc_now()
        code = exc.code if isinstance(exc, BackupError) else type(exc).__name__
        _record_run(
            cfg,
            run_id=run_id,
            kind="backup",
            status="failed",
            started_at=started_at,
            finished_at=finished_at,
            artifact_id=None,
            artifact_size=None,
            duration=(finished_at - started_at).total_seconds(),
            checksum=None,
            encrypted=cfg.encrypted,
            integrity_ok=False,
            details=details,
            error_code=code,
        )
        with contextlib.suppress(OSError):
            if temp_artifact.exists():
                shutil.rmtree(temp_artifact)
        raise
    finally:
        _release_lock(lock_fd)
    finished_at = _utc_now()
    duration = (finished_at - started_at).total_seconds()
    manifest["verified_at"] = _iso(finished_at)
    _write_manifest(final_artifact / "manifest.json", manifest)
    retention_deleted: list[str] = []
    with contextlib.suppress(BackupError):
        retention_deleted = _apply_retention(cfg)
    recorded = _record_run(
        cfg,
        run_id=run_id,
        kind="backup",
        status="succeeded",
        started_at=started_at,
        finished_at=finished_at,
        artifact_id=run_id,
        artifact_size=int(manifest["artifact_size_bytes"]),
        duration=duration,
        checksum=manifest["checksum"],
        encrypted=cfg.encrypted,
        integrity_ok=True,
        details={**details, "retention_deleted": len(retention_deleted)},
        error_code=None,
    )
    return {
        "run_id": run_id,
        "artifact": str(final_artifact),
        "created_at": manifest["created_at"],
        "size_bytes": manifest["artifact_size_bytes"],
        "encrypted": cfg.encrypted,
        "duration_seconds": round(duration, 3),
        "object_count": int(object_metadata.get("count", 0)),
        "retention_deleted": retention_deleted,
        "recorded": recorded,
    }


def _validate_target_name(source: PgConn, target_db: str, confirm: str | None) -> None:
    if not _SAFE_IDENTIFIER.fullmatch(target_db):
        raise BackupError("invalid_target", "target database name is not a safe identifier")
    reserved = {"postgres", "template0", "template1"}
    if target_db in reserved or target_db == source.database:
        raise BackupError(
            "unsafe_target",
            "target database must not be the source or a system database",
        )
    if confirm != target_db:
        raise BackupError(
            "target_confirmation_required",
            "restore requires --confirm-target with the exact target database name",
        )


def _database_exists(cfg: BackupConfig, target: PgConn) -> bool:
    admin = replace(target, database="postgres")
    result = _run(
        [
            cfg.psql_bin,
            "-X",
            "-v",
            "ON_ERROR_STOP=1",
            *admin.base_args(),
            "-At",
            "-c",
            "SELECT 1 FROM pg_database WHERE datname = "
            + "'" + target.database.replace("'", "''") + "';",
        ],
        env=target.env(),
        timeout=30,
    )
    if result.returncode != 0:
        raise BackupError("target_unreachable", "cannot reach the target PostgreSQL server")
    return result.stdout.strip() == "1"


def _create_database(cfg: BackupConfig, target: PgConn) -> None:
    admin = replace(target, database="postgres")
    _run_checked(
        [
            cfg.psql_bin,
            "-X",
            "-v",
            "ON_ERROR_STOP=1",
            *admin.base_args(),
            "-c",
            f"CREATE DATABASE {_quote_identifier(target.database)};",
        ],
        env=target.env(),
        timeout=60,
        secrets_=[target.password],
    )


def _prepare_target(
    cfg: BackupConfig, target: PgConn, *, create: bool, allow_nonempty: bool
) -> None:
    exists = _database_exists(cfg, target)
    if not exists:
        if not create:
            raise BackupError("target_missing", "target database does not exist")
        _create_database(cfg, target)
    count_text = _psql(
        target,
        "SELECT count(*) FROM pg_tables WHERE schemaname = "
        + "'" + cfg.schema.replace("'", "''") + "';",
        cfg=cfg,
    ).strip()
    if int(count_text or "0") > 0 and not allow_nonempty:
        raise BackupError("target_not_empty", "target database already contains the AI schema")
    for extension in _REQUIRED_EXTENSIONS:
        _run_checked(
            [
                cfg.psql_bin,
                "-X",
                "-v",
                "ON_ERROR_STOP=1",
                *target.base_args(),
                "-c",
                f"CREATE EXTENSION IF NOT EXISTS {_quote_identifier(extension)};",
            ],
            env=target.env(),
            timeout=60,
            secrets_=[target.password],
        )
    installed = set(
        _psql(target, "SELECT extname FROM pg_extension;", cfg=cfg).splitlines()
    )
    missing = [extension for extension in _REQUIRED_EXTENSIONS if extension not in installed]
    if missing:
        raise BackupError(
            "extension_missing",
            f"required extensions are unavailable: {', '.join(missing)}",
        )


def _restore_database(
    cfg: BackupConfig,
    artifact_dir: Path,
    manifest: dict[str, Any],
    target: PgConn,
) -> None:
    dump_path = _materialize_dump(cfg, artifact_dir, manifest)
    try:
        _run_checked(
            [
                cfg.pg_restore_bin,
                "--exit-on-error",
                "--no-owner",
                "--no-privileges",
                "--single-transaction",
                "-h",
                target.host,
                "-p",
                str(target.port),
                "-U",
                target.user,
                "-d",
                target.database,
                str(dump_path),
            ],
            env=target.env(),
            timeout=3600,
            secrets_=[target.password, cfg.passphrase],
        )
    finally:
        entry = _file_entry(manifest, "postgres.dump", "postgres.dump.gpg")
        if entry.get("encrypted") and dump_path.exists():
            dump_path.unlink()


def _target_metadata(cfg: BackupConfig, target: PgConn) -> dict[str, Any]:
    saved = cfg.pg
    try:
        return _collect_database_metadata(replace(cfg, pg=target))
    finally:
        cfg = replace(cfg, pg=saved)


def _restore_objects(
    cfg: BackupConfig,
    artifact_dir: Path,
    manifest: dict[str, Any],
    *,
    target_bucket: str,
    target_endpoint: str,
) -> dict[str, Any]:
    entry = next(
        (
            item
            for item in manifest.get("files", [])
            if item.get("name", "").startswith("objects.tar.gz")
        ),
        None,
    )
    if entry is None:
        return {"enabled": False, "restored": 0, "verified": 0}
    archive = artifact_dir / entry["name"]
    decrypted: Path | None = None
    if entry.get("encrypted"):
        decrypted = _decrypt_to_temp(cfg, archive, ".tar.gz")
        archive = decrypted
    try:
        with tempfile.TemporaryDirectory(prefix="ai-restore-objects-") as temp:
            work = Path(temp)
            index_path = _extract_objects(archive, work)
            entries = [
                json.loads(line)
                for line in index_path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            client = _s3_client(cfg, endpoint=target_endpoint)
            try:
                client.head_bucket(Bucket=target_bucket)
            except Exception:  # noqa: BLE001 - missing bucket is expected
                client.create_bucket(Bucket=target_bucket)
            for item in entries:
                key = item["key"]
                blob = work / "objects" / "blobs" / item["sha256"]
                if not blob.is_file():
                    raise BackupError("artifact_incomplete", "object archive is missing a blob")
                digest, size = _sha256_file(blob)
                if digest != item["sha256"] or size != int(item["size"]):
                    raise BackupError("artifact_corrupt", "object blob checksum mismatch")
                client.upload_file(
                    str(blob),
                    target_bucket,
                    key,
                    ExtraArgs={
                        "ContentType": item.get("content_type")
                        or "application/octet-stream"
                    },
                )
            verified = 0
            for item in entries:
                head = client.head_object(Bucket=target_bucket, Key=item["key"])
                if int(head.get("ContentLength", -1)) != int(item["size"]):
                    raise BackupError("object_restore_mismatch", "restored object size mismatch")
                verified += 1
            return {"enabled": True, "restored": len(entries), "verified": verified}
    finally:
        if decrypted and decrypted.exists():
            decrypted.unlink()


def _check_restored_metadata(
    cfg: BackupConfig,
    target: PgConn,
    manifest: dict[str, Any],
) -> list[dict[str, Any]]:
    current = _target_metadata(cfg, target)
    expected = manifest["database"]
    checks: list[dict[str, Any]] = []

    def add(name: str, ok: bool, detail: str = "") -> None:
        checks.append({"name": name, "status": "pass" if ok else "fail", "detail": detail})

    add("schema_present", bool(current.get("tables")))
    add("migration_history", current.get("migrations") == expected.get("migrations"))
    table_diffs = {
        table: {
            "expected": expected.get("table_counts", {}).get(table),
            "actual": current.get("table_counts", {}).get(table),
        }
        for table in expected.get("tables", [])
        if expected.get("table_counts", {}).get(table)
        != current.get("table_counts", {}).get(table)
    }
    critical_diffs = {
        table: diff
        for table, diff in table_diffs.items()
        if table in _CRITICAL_TABLES and table != "events" and table != "event_deliveries"
    }
    add(
        "critical_row_counts",
        not critical_diffs,
        json.dumps(critical_diffs, sort_keys=True) if critical_diffs else "",
    )
    add(
        "tenant_counts",
        current.get("tenant_counts") == expected.get("tenant_counts"),
        ""
        if current.get("tenant_counts") == expected.get("tenant_counts")
        else "tenant counts differ",
    )
    add(
        "document_object_key_count",
        current.get("document_object_keys_count") == expected.get("document_object_keys_count"),
    )
    add(
        "document_object_keys",
        current.get("document_object_keys_sha256") == expected.get("document_object_keys_sha256"),
    )
    return checks


def _check_tenant_boundaries(cfg: BackupConfig, target: PgConn) -> list[dict[str, Any]]:
    schema = _quote_identifier(cfg.schema)
    queries = {
        "document_tenant_mismatch": (
            f"SELECT count(*) FROM {schema}.documents d "
            f"JOIN {schema}.document_chunks c ON c.document_id = d.id "
            "WHERE c.tenant_id <> d.tenant_id;"
        ),
        "embedding_tenant_mismatch": (
            f"SELECT count(*) FROM {schema}.embeddings e "
            f"JOIN {schema}.document_chunks c ON c.id = e.chunk_id "
            "WHERE e.tenant_id <> c.tenant_id;"
        ),
        "object_key_tenant_mismatch": (
            f"SELECT count(*) FROM {schema}.documents "
            "WHERE object_key LIKE 'knowledge/%' "
            "AND object_key ~ '^knowledge/[0-9]+/' "
            "AND split_part(object_key, '/', 2)::bigint <> tenant_id;"
        ),
        "event_delivery_duplicates": (
            f"SELECT count(*) FROM (SELECT event_id, consumer_group FROM {schema}.event_deliveries "
            "GROUP BY event_id, consumer_group HAVING count(*) > 1) duplicate;"
        ),
    }
    checks: list[dict[str, Any]] = []
    for name, sql in queries.items():
        value = int(_psql(target, sql, cfg=cfg).strip() or "0")
        checks.append(
            {
                "name": f"tenant_{name}",
                "status": "pass" if value == 0 else "fail",
                "detail": "" if value == 0 else str(value),
            }
        )
    constraint = _psql(
        target,
        "SELECT count(*) FROM pg_constraint WHERE conname = 'event_deliveries_uniq';",
        cfg=cfg,
    ).strip()
    checks.append(
        {
            "name": "event_idempotency_constraint",
            "status": "pass" if constraint == "1" else "fail",
            "detail": "",
        }
    )
    return checks


def _check_search(cfg: BackupConfig, target: PgConn) -> list[dict[str, Any]]:
    schema = _quote_identifier(cfg.schema)
    counts = _psql(
        target,
        f"SELECT count(*), count(embedding) FROM {schema}.embeddings;",
        cfg=cfg,
    ).strip()
    total, vectors = (counts.split("\t") + ["0", "0"])[:2]
    if int(total or "0") == 0:
        return [{"name": "vector_search", "status": "skip", "detail": "no embeddings in backup"}]
    nearest = _psql(
        target,
        f"SELECT count(*) FROM (SELECT id FROM {schema}.embeddings "
        f"WHERE embedding IS NOT NULL ORDER BY embedding <=> "
        f"(SELECT embedding FROM {schema}.embeddings WHERE embedding IS NOT NULL LIMIT 1) "
        "LIMIT 5) nearest;",
        cfg=cfg,
    ).strip()
    return [
        {
            "name": "vector_search",
            "status": "pass" if int(vectors or "0") > 0 and int(nearest or "0") > 0 else "fail",
            "detail": f"embeddings={vectors}",
        }
    ]


def _check_document_objects(
    cfg: BackupConfig,
    target: PgConn,
    *,
    target_bucket: str,
    target_endpoint: str,
) -> dict[str, Any]:
    schema = _quote_identifier(cfg.schema)
    rows = _psql(
        target,
        f"SELECT object_key, tenant_id FROM {schema}.documents WHERE object_key IS NOT NULL;",
        cfg=cfg,
    ).splitlines()
    if not rows:
        return {"checked": 0, "missing": 0, "mismatched": 0}
    client = _s3_client(cfg, endpoint=target_endpoint)
    missing = 0
    mismatched = 0
    for row in rows:
        key, _, tenant = row.partition("\t")
        parts = key.split("/")
        if (
            parts[0] == "knowledge"
            and len(parts) >= 3
            and parts[1].isdigit()
            and parts[1] != tenant
        ):
            mismatched += 1
        try:
            client.head_object(Bucket=target_bucket, Key=key)
        except Exception:  # noqa: BLE001 - any failure means the object is unavailable
            missing += 1
    return {"checked": len(rows), "missing": missing, "mismatched": mismatched}


def _worker_env(cfg: BackupConfig, target: PgConn, bucket: str) -> dict[str, str]:
    env = os.environ.copy()
    root = Path(__file__).resolve().parent.parent
    existing = env.get("PYTHONPATH", "")
    python_path = str(root / "apps" / "ai-api" / "src")
    env["PYTHONPATH"] = python_path + (os.pathsep + existing if existing else "")
    env.pop("AI_DB_ROLE_PROFILE", None)
    env.pop("AI_DB_EXPECTED_ROLE", None)
    # Never leak the backup's system-scope or migration SET ROLE option into
    # the app-check process.
    env.pop("PGOPTIONS", None)
    env.update(
        {
            "AI_ENV": "development",
            "AI_REPOSITORY": "postgres",
            "POSTGRES_HOST": target.host,
            "POSTGRES_PORT": str(target.port),
            "POSTGRES_DB": target.database,
            "POSTGRES_USER": target.user,
            "POSTGRES_PASSWORD": target.password,
            "AI_DB_SCHEMA": cfg.schema,
            "S3_ENDPOINT": cfg.s3_endpoint,
            "S3_REGION": cfg.s3_region,
            "S3_BUCKET": bucket,
            "S3_ACCESS_KEY_ID": cfg.s3_access_key_id,
            "S3_SECRET_ACCESS_KEY": cfg.s3_secret_access_key,
            "S3_FORCE_PATH_STYLE": "true" if cfg.s3_force_path_style else "false",
            "SEARCH_PROVIDER": "postgres",
            "EVENT_BUS_PROVIDER": "database",
            "AI_INGEST_INLINE": "false",
            "AI_DOCS_ENABLED": "false",
            "LLM_PROVIDER": "mock",
            "AI_METRICS_AUTH_TOKEN": secrets.token_hex(24),
            "OTEL_ENABLED": "false",
        }
    )
    return env


def _start_app_check(cfg: BackupConfig, target: PgConn, bucket: str) -> list[dict[str, Any]]:
    env = _worker_env(cfg, target, bucket)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        port = int(probe.getsockname()[1])
    env["AI_API_HOST"] = "127.0.0.1"
    env["AI_API_PORT"] = str(port)
    env["AI_API_LOG_LEVEL"] = "warning"
    command = [
        sys.executable,
        "-m",
        "uvicorn",
        "ai_api.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "--log-level",
        "warning",
    ]
    with tempfile.TemporaryFile(mode="w+b") as log:
        process = subprocess.Popen(
            command,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
        )
        ready = False
        last_error = ""
        try:
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    break
                try:
                    with urllib.request.urlopen(
                        f"http://127.0.0.1:{port}/readyz", timeout=2
                    ) as response:
                        if response.status == 200:
                            ready = True
                            break
                except (urllib.error.URLError, TimeoutError) as exc:
                    last_error = type(exc).__name__
                time.sleep(1)
            health_ok = False
            if ready:
                try:
                    with urllib.request.urlopen(
                        f"http://127.0.0.1:{port}/healthz", timeout=3
                    ) as response:
                        health_ok = response.status == 200
                except (urllib.error.URLError, TimeoutError):
                    health_ok = False
        finally:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            log.seek(0)
            output = _redact(
                log.read().decode("utf-8", errors="replace")[-2000:],
                [target.password],
            )
    checks = [
        {
            "name": "api_readiness",
            "status": "pass" if ready else "fail",
            "detail": "" if ready else (last_error or "readiness timed out"),
        },
        {"name": "api_liveness", "status": "pass" if health_ok else "fail", "detail": ""},
    ]
    if not ready and output:
        _log("restore.api_check_output", output=output)
    return checks


def _run_worker_checks(cfg: BackupConfig, target: PgConn, bucket: str) -> list[dict[str, Any]]:
    env = _worker_env(cfg, target, bucket)
    checks: list[dict[str, Any]] = []
    for worker in ("event_consumer", "indexer", "reconciler", "agent"):
        try:
            result = _run(
                [sys.executable, "-m", f"ai_api.workers.{worker}", "--once"],
                env=env,
                timeout=120,
            )
            ok = result.returncode == 0
            detail = (
                ""
                if ok
                else _redact(
                    (result.stderr or result.stdout or "")[-500:], [target.password]
                )
            )
        except BackupError as exc:
            ok = False
            detail = exc.code
        checks.append(
            {
                "name": f"worker_{worker}",
                "status": "pass" if ok else "fail",
                "detail": detail,
            }
        )
    return checks


def restore_artifact(
    cfg: BackupConfig,
    artifact_dir: Path,
    *,
    target: PgConn,
    create_database: bool,
    allow_nonempty: bool,
    target_bucket: str | None,
    target_endpoint: str | None,
) -> dict[str, Any]:
    manifest = json.loads((artifact_dir / "manifest.json").read_text(encoding="utf-8"))
    _prepare_target(cfg, target, create=create_database, allow_nonempty=allow_nonempty)
    started = time.monotonic()
    _restore_database(cfg, artifact_dir, manifest, target)
    checks = _check_restored_metadata(cfg, target, manifest)
    checks.extend(_check_tenant_boundaries(cfg, target))
    checks.extend(_check_search(cfg, target))
    object_result: dict[str, Any] = {"enabled": False, "restored": 0, "verified": 0}
    if target_bucket:
        object_result = _restore_objects(
            cfg,
            artifact_dir,
            manifest,
            target_bucket=target_bucket,
            target_endpoint=target_endpoint or cfg.s3_endpoint,
        )
        documents = _check_document_objects(
            cfg,
            target,
            target_bucket=target_bucket,
            target_endpoint=target_endpoint or cfg.s3_endpoint,
        )
        checks.append(
            {
                "name": "document_object_links",
                "status": (
                    "pass"
                    if documents["missing"] == 0 and documents["mismatched"] == 0
                    else "fail"
                ),
                "detail": json.dumps(documents, sort_keys=True),
            }
        )
    checks.append(
        {
            "name": "restore_elapsed",
            "status": "pass",
            "detail": f"{time.monotonic() - started:.3f}s",
        }
    )
    failures = [check for check in checks if check["status"] == "fail"]
    if failures:
        raise BackupError(
            "restore_validation_failed",
            "restored database failed validation: "
            + ", ".join(check["name"] for check in failures),
        )
    return {
        "manifest": manifest,
        "checks": checks,
        "objects": object_result,
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "target": {
            "database": target.database,
            "host": target.host,
            "port": target.port,
            "bucket": target_bucket,
        },
    }


def _drill_id() -> str:
    return f"{_utc_now():%Y%m%dT%H%M%SZ}-{secrets.token_hex(3)}"


def _write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    path.chmod(0o644)


def run_drill(
    cfg: BackupConfig,
    *,
    artifact: str | None,
    start_app: bool,
    run_workers: bool,
) -> dict[str, Any]:
    drill_id = _drill_id()
    started_at = _utc_now()
    started = time.monotonic()
    report: dict[str, Any] = {
        "drill_version": 1,
        "drill_id": drill_id,
        "drill_timestamp": _iso(started_at),
        "backup": {},
        "target": {},
        "components": [],
        "checks": [],
        "result": "failed",
        "elapsed_seconds": 0,
        "data_loss": {
            "expected_window": f"up to {cfg.retention_days}d retention; RPO target <= 24h",
            "observed": "none beyond the backup point",
        },
        "deviations": [],
        "follow_up_actions": [],
        "cleanup": {"status": "deferred", "reason": "destructive cleanup requires an operator"},
    }
    target_db = f"ai_restore_drill_{_utc_now():%Y%m%d_%H%M%S}"
    target_user = os.environ.get("RESTORE_TARGET_USER") or cfg.pg.user
    target_password = os.environ.get("RESTORE_TARGET_PASSWORD")
    if not target_password and target_user == cfg.pg.user:
        target_password = cfg.pg.password
    if not target_password:
        raise BackupError(
            "missing_target_password",
            "set RESTORE_TARGET_PASSWORD for the restore/drill role",
        )
    target = replace(
        cfg.pg,
        database=target_db,
        user=target_user,
        password=target_password,
    )
    restore_profile = os.environ.get("RESTORE_TARGET_ROLE_PROFILE", "").strip().lower()
    if restore_profile:
        _verify_restore_role(
            cfg,
            target,
            profile=restore_profile,
            expected=os.environ.get("RESTORE_TARGET_EXPECTED_ROLE", "").strip() or None,
            require_createdb=True,
        )
    target_bucket = f"ai-knowledge-restore-drill-{_utc_now():%Y%m%d%H%M%S}"
    try:
        if artifact:
            artifact_dir = _resolve_artifact(cfg, artifact)
        else:
            created = create_backup(cfg)
            artifact_dir = Path(created["artifact"])
        manifest = json.loads((artifact_dir / "manifest.json").read_text(encoding="utf-8"))
        report["backup"] = {
            "run_id": manifest["run_id"],
            "created_at": manifest["created_at"],
            "checksum": manifest["checksum"],
            "size_bytes": manifest.get("artifact_size_bytes"),
            "encrypted": bool(manifest.get("encryption", {}).get("enabled")),
        }
        report["target"] = {
            "database": target_db,
            "bucket": target_bucket,
            "isolated_from_source_database": target_db != cfg.pg.database,
        }
        _validate_target_name(cfg.pg, target_db, target_db)
        verified = verify_artifact(cfg, artifact_dir)
        report["checks"].append(
            {"name": "artifact_integrity", "status": "pass", "detail": ",".join(verified["checks"])}
        )
        restored = restore_artifact(
            cfg,
            artifact_dir,
            target=target,
            create_database=True,
            allow_nonempty=False,
            target_bucket=target_bucket,
            target_endpoint=cfg.s3_endpoint,
        )
        report["checks"].extend(restored["checks"])
        report["components"] = [
            {"name": "postgresql", "action": "restored", "detail": target_db},
            {
                "name": "object_storage",
                "action": "restored" if restored["objects"]["enabled"] else "skipped",
                "detail": target_bucket,
            },
            {
                "name": "opensearch",
                "action": "not_required",
                "detail": "reconstructible; deployed default is PostgreSQL search",
            },
            {
                "name": "kafka",
                "action": "not_required",
                "detail": "database outbox is authoritative",
            },
            {"name": "redis", "action": "not_required", "detail": "cache-only"},
        ]
        if start_app:
            report["checks"].extend(_start_app_check(cfg, target, target_bucket))
        if run_workers:
            report["checks"].extend(_run_worker_checks(cfg, target, target_bucket))
        report["deviations"].append(
            "Restore target is an isolated database on the same PostgreSQL server; "
            "no separate physical cluster was available."
        )
        report["deviations"].append(
            "Enterprise IAM authentication is external to the AI schema and was not "
            "exercised; tenant boundary checks were run against restored rows."
        )
        report["follow_up_actions"].append(
            f"When approved, remove scratch database {target_db} and bucket "
            f"{target_bucket} using the documented cleanup procedure."
        )
        failures = [check for check in report["checks"] if check["status"] == "fail"]
        report["result"] = "success" if not failures else "failed"
        report["elapsed_seconds"] = round(time.monotonic() - started, 3)
        if failures:
            raise BackupError("drill_validation_failed", "restore drill validation failed")
        return report
    except Exception as exc:
        report["result"] = "failed"
        report["elapsed_seconds"] = round(time.monotonic() - started, 3)
        report["checks"].append(
            {
                "name": "drill_error",
                "status": "fail",
                "detail": exc.code if isinstance(exc, BackupError) else type(exc).__name__,
            }
        )
        raise
    finally:
        report_path = cfg.drill_dir / f"drill-{drill_id}.json"
        report["report_path"] = str(report_path)
        _write_report(report_path, report)
        finished_at = _utc_now()
        _record_run(
            cfg,
            run_id=drill_id,
            kind="restore_drill",
            status="succeeded" if report["result"] == "success" else "failed",
            started_at=started_at,
            finished_at=finished_at,
            artifact_id=report.get("backup", {}).get("run_id"),
            artifact_size=int(report.get("backup", {}).get("size_bytes") or 0) or None,
            duration=(finished_at - started_at).total_seconds(),
            checksum=report.get("backup", {}).get("checksum"),
            encrypted=bool(report.get("backup", {}).get("encrypted")),
            integrity_ok=report["result"] == "success",
            details={
                "checks": len(report["checks"]),
                "failures": len([check for check in report["checks"] if check["status"] == "fail"]),
                "target_database": target_db,
                "target_bucket": target_bucket,
            },
            error_code=None if report["result"] == "success" else "drill_failed",
        )



def cleanup_drill(
    cfg: BackupConfig,
    *,
    target_db: str,
    confirm_db: str,
    target_bucket: str,
    confirm_bucket: str,
    execute: bool,
) -> dict[str, Any]:
    _validate_target_name(cfg.pg, target_db, confirm_db)
    if target_bucket != confirm_bucket:
        raise BackupError("target_confirmation_required", "bucket confirmation does not match")
    if not target_db.startswith("ai_restore_drill_") or not target_bucket.startswith(
        "ai-knowledge-restore-drill-"
    ):
        raise BackupError("unsafe_target", "refusing to clean a non-drill target")
    if not execute:
        return {
            "executed": False,
            "database": target_db,
            "bucket": target_bucket,
            "message": "dry run; pass --execute to delete the drill target",
        }
    target_user = os.environ.get("RESTORE_TARGET_USER") or cfg.pg.user
    target_password = os.environ.get("RESTORE_TARGET_PASSWORD")
    if not target_password and target_user == cfg.pg.user:
        target_password = cfg.pg.password
    if not target_password:
        raise BackupError(
            "missing_target_password",
            "set RESTORE_TARGET_PASSWORD to drop the drill database",
        )
    admin = replace(
        cfg.pg,
        database="postgres",
        user=target_user,
        password=target_password,
    )
    _run_checked(
        [
            cfg.psql_bin,
            "-X",
            "-v",
            "ON_ERROR_STOP=1",
            *admin.base_args(),
            "-c",
            f"DROP DATABASE {_quote_identifier(target_db)};",
        ],
        env=admin.env(),
        timeout=60,
        secrets_=[admin.password],
    )
    client = _s3_client(cfg)
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=target_bucket):
        keys = [{"Key": item["Key"]} for item in page.get("Contents", [])]
        if keys:
            client.delete_objects(Bucket=target_bucket, Delete={"Objects": keys})
    client.delete_bucket(Bucket=target_bucket)
    return {"executed": True, "database": target_db, "bucket": target_bucket}


def _target_conn(
    cfg: BackupConfig,
    args: argparse.Namespace,
) -> PgConn:
    user = (
        getattr(args, "target_user", None)
        or os.environ.get("RESTORE_TARGET_USER")
        or cfg.pg.user
    )
    password = getattr(args, "target_password", None) or os.environ.get(
        "RESTORE_TARGET_PASSWORD"
    )
    if not password and user == cfg.pg.user:
        password = cfg.pg.password
    if not password:
        raise BackupError(
            "missing_target_password",
            "set RESTORE_TARGET_PASSWORD (or --target-password) for the restore role",
        )
    return PgConn(
        host=getattr(args, "target_host", None) or cfg.pg.host,
        port=int(getattr(args, "target_port", None) or cfg.pg.port),
        database=args.target_db,
        user=user,
        password=password,
        sslmode=cfg.pg.sslmode,
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AI platform backup, verification and restore")
    parser.add_argument("--backup-dir", help="override BACKUP_DIR")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("backup", help="create and verify a new backup")

    verify = subparsers.add_parser("verify", help="verify an existing artifact")
    verify.add_argument("--artifact", help="artifact path or run id (default: latest)")

    restore = subparsers.add_parser("restore", help="restore an artifact into an isolated database")
    restore.add_argument("--artifact", help="artifact path or run id (default: latest)")
    restore.add_argument("--target-db", required=True)
    restore.add_argument("--confirm-target", required=True)
    restore.add_argument("--target-host")
    restore.add_argument("--target-port", type=int)
    restore.add_argument("--target-user")
    restore.add_argument("--target-password")
    restore.add_argument("--create-database", action="store_true")
    restore.add_argument("--allow-nonempty", action="store_true")
    restore.add_argument("--restore-objects", action="store_true")
    restore.add_argument("--target-bucket")
    restore.add_argument("--target-s3-endpoint")

    drill = subparsers.add_parser("drill", help="back up and restore into an isolated drill target")
    drill.add_argument("--artifact", help="reuse an existing artifact instead of creating one")
    drill.add_argument(
        "--start-app", action="store_true", help="start an API process against the target"
    )
    drill.add_argument(
        "--run-workers",
        action="store_true",
        help="run each worker once against the target",
    )

    cleanup = subparsers.add_parser("cleanup", help="remove an isolated drill target")
    cleanup.add_argument("--target-db", required=True)
    cleanup.add_argument("--confirm-target", required=True)
    cleanup.add_argument("--target-bucket", required=True)
    cleanup.add_argument("--confirm-bucket", required=True)
    cleanup.add_argument("--execute", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        cfg = BackupConfig.from_env()
        if args.backup_dir:
            cfg = replace(cfg, backup_dir=Path(args.backup_dir).expanduser())
        if cfg.role_profile:
            _verify_role(
                cfg.pg,
                cfg,
                profile=cfg.role_profile,
                expected=cfg.expected_role or None,
            )
        restore_profile = os.environ.get("RESTORE_TARGET_ROLE_PROFILE", "").strip().lower()
        restore_expected = os.environ.get("RESTORE_TARGET_EXPECTED_ROLE", "").strip()
        if args.command == "backup":
            result = create_backup(cfg)
        elif args.command == "verify":
            artifact = _resolve_artifact(cfg, args.artifact)
            result = verify_artifact(cfg, artifact)
            result["artifact"] = str(artifact)
        elif args.command == "restore":
            _validate_target_name(cfg.pg, args.target_db, args.confirm_target)
            artifact = _resolve_artifact(cfg, args.artifact)
            target = _target_conn(cfg, args)
            if restore_profile:
                _verify_restore_role(
                    cfg,
                    target,
                    profile=restore_profile,
                    expected=restore_expected or None,
                    require_createdb=bool(args.create_database),
                )
            restored = restore_artifact(
                cfg,
                artifact,
                target=target,
                create_database=args.create_database,
                allow_nonempty=args.allow_nonempty,
                target_bucket=args.target_bucket if args.restore_objects else None,
                target_endpoint=args.target_s3_endpoint,
            )
            result = {
                "run_id": restored["manifest"]["run_id"],
                "target": restored["target"],
                "checks": restored["checks"],
                "objects": restored["objects"],
                "elapsed_seconds": restored["elapsed_seconds"],
            }
        elif args.command == "drill":
            result = run_drill(
                cfg,
                artifact=args.artifact,
                start_app=args.start_app,
                run_workers=args.run_workers,
            )
        elif args.command == "cleanup":
            result = cleanup_drill(
                cfg,
                target_db=args.target_db,
                confirm_db=args.confirm_target,
                target_bucket=args.target_bucket,
                confirm_bucket=args.confirm_bucket,
                execute=args.execute,
            )
        else:  # pragma: no cover - argparse enforces the command
            parser.error("unknown command")
            return 2
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result.get("result", "success") != "failed" else 1
    except BackupError as exc:
        print(json.dumps({"error": exc.code, "detail": str(exc)}, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
