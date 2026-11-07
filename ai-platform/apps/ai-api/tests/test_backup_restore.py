from __future__ import annotations

import importlib.util
import json
import os
import sys
import tarfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


def _load_backup_module():
    spec = importlib.util.spec_from_file_location(
        "backup_restore", ROOT / "scripts" / "backup_restore.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


backup = _load_backup_module()


def _config(tmp_path: Path, **overrides):
    base = {
        "backup_dir": tmp_path / "backups",
        "pg": backup.PgConn(
            host="127.0.0.1",
            port=5432,
            database="helix",
            user="helix",
            password="super-secret",
        ),
        "schema": "ai",
        "scope": "schema",
        "s3_endpoint": "http://127.0.0.1:8333",
        "s3_region": "us-east-1",
        "s3_bucket": "ai-knowledge",
        "s3_access_key_id": "",
        "s3_secret_access_key": "",
        "s3_force_path_style": True,
        "object_prefix": "",
        "backup_objects": False,
        "passphrase": "",
        "require_encryption": False,
        "retention_days": 14,
        "retention_min_count": 3,
    }
    base.update(overrides)
    return backup.BackupConfig(**base)


def test_pg_connection_env_sets_transaction_system_scope(monkeypatch) -> None:
    monkeypatch.setenv("PGOPTIONS", "-c statement_timeout=5000")
    conn = backup.PgConn("db", 5432, "helix", "helix", "pw")
    env = conn.env()
    assert env["PGPASSWORD"] == "pw"
    assert "-c ai.system_access=on" in env["PGOPTIONS"]
    assert "-c statement_timeout=5000" in env["PGOPTIONS"]


def _role_state(role: str, **overrides):
    state = {
        "role_name": role,
        "superuser": False,
        "createdb": False,
        "createrole": False,
        "bypassrls": False,
        "system_member": True,
        "owns_ai_tables": False,
    }
    state.update(overrides)
    return state


def test_backup_role_verifier_rejects_owner(monkeypatch, tmp_path: Path) -> None:
    cfg = _config(tmp_path)
    monkeypatch.setattr(
        backup, "_role_state", lambda *_args: _role_state("ai_backup", owns_ai_tables=True)
    )
    with pytest.raises(backup.BackupError, match="database role is not permitted"):
        backup._verify_role(cfg.pg, cfg, profile="backup", expected="ai_backup")


def test_backup_role_verifier_requires_system_membership(
    monkeypatch, tmp_path: Path
) -> None:
    cfg = _config(tmp_path)
    monkeypatch.setattr(
        backup, "_role_state", lambda *_args: _role_state("ai_backup", system_member=False)
    )
    with pytest.raises(backup.BackupError, match="database role is not permitted"):
        backup._verify_role(cfg.pg, cfg, profile="backup", expected="ai_backup")


def test_restore_role_verifier_can_require_createdb(monkeypatch, tmp_path: Path) -> None:
    cfg = _config(tmp_path)
    monkeypatch.setattr(backup, "_role_state", lambda *_args: _role_state("ai_restore"))
    with pytest.raises(backup.BackupError, match="database role is not permitted"):
        backup._verify_role(
            cfg.pg, cfg, profile="restore", expected="ai_restore", require_createdb=True
        )
    monkeypatch.setattr(
        backup, "_role_state", lambda *_args: _role_state("ai_restore", createdb=True)
    )
    backup._verify_role(
        cfg.pg, cfg, profile="restore", expected="ai_restore", require_createdb=True
    )


def test_restore_role_verifier_probes_maintenance_database(monkeypatch, tmp_path: Path) -> None:
    cfg = _config(tmp_path)
    target = backup.PgConn("db", 5432, "ai_restore_drill_20260101_000000", "ai_restore", "pw")
    seen: list[str] = []

    def _fake_verify(conn, *_args, **_kwargs):
        seen.append(conn.database)

    monkeypatch.setattr(backup, "_verify_role", _fake_verify)
    backup._verify_restore_role(
        cfg, target, profile="restore", expected="ai_restore", require_createdb=True
    )
    # The drill database does not exist yet, so the attribute probe must use
    # the maintenance database instead.
    assert seen == ["postgres"]


def test_restore_role_verifier_rejects_source_schema_ownership(
    monkeypatch, tmp_path: Path
) -> None:
    cfg = _config(tmp_path)
    target = backup.PgConn("db", 5432, "ai_restore_drill_20260101_000000", "ai_restore", "pw")
    monkeypatch.setattr(
        backup,
        "_role_state",
        lambda *_args: _role_state("ai_restore", createdb=True, owns_ai_tables=True),
    )
    with pytest.raises(backup.BackupError, match="database role is not permitted"):
        backup._verify_restore_role(
            cfg, target, profile="restore", expected="ai_restore", require_createdb=True
        )


def test_app_check_env_does_not_inherit_role_profile(monkeypatch, tmp_path: Path) -> None:
    cfg = _config(tmp_path)
    monkeypatch.setenv("AI_DB_ROLE_PROFILE", "backup")
    monkeypatch.setenv("AI_DB_EXPECTED_ROLE", "ai_backup")
    monkeypatch.setenv("PGOPTIONS", "-c ai.system_access=on -c role=ai_owner")
    target = backup.PgConn("db", 5432, "target", "ai_restore", "pw")
    env = backup._worker_env(cfg, target, "bucket")
    assert "AI_DB_ROLE_PROFILE" not in env
    assert "AI_DB_EXPECTED_ROLE" not in env
    assert "PGOPTIONS" not in env


def _write_artifact(
    path: Path,
    *,
    run_id: str = "20261025T000000Z-abcdef",
    created_at: datetime | None = None,
    files: dict[str, bytes] | None = None,
    encrypted: bool = False,
) -> None:
    path.mkdir(parents=True)
    payloads = files or {"postgres.dump": b"fake dump"}
    entries = []
    for name, content in payloads.items():
        (path / name).write_bytes(content)
        import hashlib

        entries.append(
            {
                "name": name,
                "sha256": hashlib.sha256(content).hexdigest(),
                "size": len(content),
                "encrypted": encrypted,
            }
        )
    manifest = {
        "manifest_version": backup.MANIFEST_VERSION,
        "run_id": run_id,
        "kind": "backup",
        "status": "succeeded",
        "created_at": backup._iso(created_at or datetime.now(UTC)),
        "encryption": {"enabled": encrypted},
        "files": entries,
        "artifact_size_bytes": sum(entry["size"] for entry in entries),
    }
    (path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


def test_checksum_detects_payload_modification(tmp_path: Path) -> None:
    artifact = tmp_path / "artifact"
    _write_artifact(artifact)
    manifest = json.loads((artifact / "manifest.json").read_text())
    backup._verify_checksums(artifact, manifest)
    (artifact / "postgres.dump").write_bytes(b"tampered")
    with pytest.raises(backup.BackupError) as exc:
        backup._verify_checksums(artifact, manifest)
    assert exc.value.code == "artifact_corrupt"


def test_missing_payload_is_rejected(tmp_path: Path) -> None:
    artifact = tmp_path / "artifact"
    _write_artifact(artifact)
    (artifact / "postgres.dump").unlink()
    manifest = json.loads((artifact / "manifest.json").read_text())
    with pytest.raises(backup.BackupError) as exc:
        backup._verify_checksums(artifact, manifest)
    assert exc.value.code == "artifact_incomplete"


def test_unsafe_manifest_path_is_rejected(tmp_path: Path) -> None:
    artifact = tmp_path / "artifact"
    _write_artifact(artifact)
    manifest = json.loads((artifact / "manifest.json").read_text())
    manifest["files"][0]["name"] = "../postgres.dump"
    with pytest.raises(backup.BackupError) as exc:
        backup._verify_checksums(artifact, manifest)
    assert exc.value.code == "invalid_artifact"


def test_gpg_environment_is_writable_and_isolated(tmp_path: Path) -> None:
    # The backup image has no home directory and a read-only root filesystem;
    # the default $HOME/.gnupg is therefore unusable. The helper must point gpg
    # at a fresh, private directory and clean it up afterwards.
    with backup._gpg_environment() as env:
        home = Path(env["GNUPGHOME"])
        assert env["HOME"] == env["GNUPGHOME"]
        assert home.is_dir()
        assert (home.stat().st_mode & 0o777) == 0o700
        (home / "pubring.kbx").write_text("probe")
    assert not home.exists()


def test_encrypted_artifact_requires_passphrase(tmp_path: Path) -> None:
    artifact = tmp_path / "artifact"
    _write_artifact(artifact, files={"postgres.dump.gpg": b"ciphertext"}, encrypted=True)
    with pytest.raises(backup.BackupError) as exc:
        backup.verify_artifact(_config(tmp_path), artifact, deep=False)
    assert exc.value.code == "encryption_key_unavailable"


def test_retention_keeps_minimum_and_newest(tmp_path: Path) -> None:
    cfg = _config(tmp_path, retention_days=1, retention_min_count=2)
    cfg.artifacts_dir.mkdir(parents=True)
    now = datetime.now(UTC)
    for index, age_days in enumerate((10, 8, 6, 4, 2)):
        _write_artifact(
            cfg.artifacts_dir / f"2026100{index}T000000Z-abcdef",
            created_at=now - timedelta(days=age_days),
        )
    deleted = backup._apply_retention(cfg, now=now)
    remaining = sorted(path.name for path in cfg.artifacts_dir.iterdir() if path.is_dir())
    assert len(deleted) == 3
    assert len(remaining) == 2
    assert "20261004T000000Z-abcdef" in remaining


def test_retention_never_deletes_the_only_recovery_point(tmp_path: Path) -> None:
    cfg = _config(tmp_path, retention_days=1, retention_min_count=3)
    cfg.artifacts_dir.mkdir(parents=True)
    _write_artifact(
        cfg.artifacts_dir / "20261001T000000Z-abcdef",
        created_at=datetime.now(UTC) - timedelta(days=30),
    )
    assert backup._apply_retention(cfg) == []
    assert (cfg.artifacts_dir / "20261001T000000Z-abcdef").is_dir()


def test_validate_target_rejects_source_and_requires_confirmation() -> None:
    source = backup.PgConn("db", 5432, "helix", "helix", "pw")
    with pytest.raises(backup.BackupError) as exc:
        backup._validate_target_name(source, "helix", "helix")
    assert exc.value.code == "unsafe_target"
    with pytest.raises(backup.BackupError) as exc:
        backup._validate_target_name(source, "postgres", "postgres")
    assert exc.value.code == "unsafe_target"
    with pytest.raises(backup.BackupError) as exc:
        backup._validate_target_name(source, "ai_restore_drill_1", "wrong")
    assert exc.value.code == "target_confirmation_required"
    backup._validate_target_name(source, "ai_restore_drill_1", "ai_restore_drill_1")


def test_concurrent_backup_lock_is_rejected(tmp_path: Path) -> None:
    cfg = _config(tmp_path)
    cfg.backup_dir.mkdir()
    fd = backup._acquire_lock(cfg, "20261025T000000Z-abcdef")
    try:
        with pytest.raises(backup.BackupError) as exc:
            backup._acquire_lock(cfg, "20261025T000001Z-abcdef")
        assert exc.value.code == "backup_locked"
    finally:
        backup._release_lock(fd)
    fd = backup._acquire_lock(cfg, "20261025T000002Z-abcdef")
    backup._release_lock(fd)


def test_required_encryption_fails_closed_without_key(tmp_path: Path) -> None:
    cfg = _config(tmp_path, require_encryption=True)
    with pytest.raises(backup.BackupError) as exc:
        cfg.validate()
    assert exc.value.code == "encryption_required"


def test_config_repr_hides_credentials(tmp_path: Path) -> None:
    cfg = _config(tmp_path, passphrase="passphrase-value")
    rendered = repr(cfg)
    assert "super-secret" not in rendered
    assert "passphrase-value" not in rendered


def test_object_archive_roundtrip(tmp_path: Path) -> None:
    work = tmp_path / "work"
    blobs = work / "blobs"
    blobs.mkdir(parents=True)
    content = b"document bytes"
    import hashlib

    digest = hashlib.sha256(content).hexdigest()
    (blobs / digest).write_bytes(content)
    index = work / "index.jsonl"
    index.write_text(
        json.dumps({"key": "knowledge/1/a.txt", "sha256": digest, "size": len(content)}) + "\n"
    )
    archive = tmp_path / "objects.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        backup._tar_add_file(tar, index, "objects/index.jsonl", 0o644)
        backup._tar_add_file(tar, blobs / digest, f"objects/blobs/{digest}", 0o600)
    destination = tmp_path / "extracted"
    index_path = backup._extract_objects(archive, destination)
    assert index_path.is_file()
    assert (destination / "objects" / "blobs" / digest).read_bytes() == content


def test_object_archive_rejects_traversal(tmp_path: Path) -> None:
    archive = tmp_path / "evil.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        info = tarfile.TarInfo("../escape")
        info.size = 1
        import io

        tar.addfile(info, io.BytesIO(b"x"))
    with pytest.raises(backup.BackupError) as exc:
        backup._extract_objects(archive, tmp_path / "out")
    assert exc.value.code == "invalid_artifact"


def test_drill_cleanup_requires_matching_confirmations(tmp_path: Path) -> None:
    cfg = _config(tmp_path)
    with pytest.raises(backup.BackupError) as exc:
        backup.cleanup_drill(
            cfg,
            target_db="ai_restore_drill_1",
            confirm_db="wrong",
            target_bucket="ai-knowledge-restore-drill-1",
            confirm_bucket="ai-knowledge-restore-drill-1",
            execute=False,
        )
    assert exc.value.code == "target_confirmation_required"
    with pytest.raises(backup.BackupError) as exc:
        backup.cleanup_drill(
            cfg,
            target_db="production",
            confirm_db="production",
            target_bucket="ai-knowledge-restore-drill-1",
            confirm_bucket="ai-knowledge-restore-drill-1",
            execute=False,
        )
    assert exc.value.code == "unsafe_target"


def test_backup_metrics_reflect_latest_run() -> None:
    from datetime import datetime

    from prometheus_client import generate_latest

    from ai_api.telemetry import backup_metrics

    finished = datetime(2026, 10, 25, 7, 0, tzinfo=UTC)

    class FakeDb:
        async def fetch(self, _query: str):
            return [
                {
                    "kind": "backup",
                    "status": "failed",
                    "finished_at": finished,
                    "duration_seconds": 12.5,
                    "artifact_size_bytes": 1024,
                    "integrity_ok": False,
                    "encrypted": True,
                    "last_success": finished - timedelta(hours=1),
                }
            ]

    import asyncio

    asyncio.run(backup_metrics.refresh_backup_metrics(FakeDb()))
    text = generate_latest(backup_metrics.REGISTRY).decode()
    assert 'ai_backup_last_run_status{kind="backup"} 0.0' in text
    assert 'ai_backup_last_integrity_ok{kind="backup"} 0.0' in text
    assert 'ai_backup_last_encrypted{kind="backup"} 1.0' in text
    assert 'ai_backup_last_artifact_size_bytes{kind="backup"} 1024.0' in text


@pytest.mark.integration
def test_live_backup_and_verification(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    if os.environ.get("AI_TEST_BACKUP", "") != "1":
        pytest.skip("set AI_TEST_BACKUP=1 to run a real backup")
    monkeypatch.setenv("BACKUP_DIR", str(tmp_path / "backups"))
    monkeypatch.setenv("BACKUP_OBJECTS", "0")
    monkeypatch.setenv("BACKUP_ENCRYPTION_PASSPHRASE", "integration-passphrase")
    cfg = backup.BackupConfig.from_env()
    result = backup.create_backup(cfg)
    artifact = Path(result["artifact"])
    verified = backup.verify_artifact(cfg, artifact)
    assert verified["run_id"] == result["run_id"]
    assert "pg_restore_list" in verified["checks"]
    assert (artifact / "manifest.json").is_file()
    assert not any(
        "integration-passphrase" in json.dumps(entry)
        for entry in json.loads((artifact / "manifest.json").read_text()).values()
        if isinstance(entry, (str, dict, list))
    )


def test_dump_uses_exported_snapshot(tmp_path: Path) -> None:
    cfg = _config(tmp_path)
    args = backup._source_dump_args(
        cfg, tmp_path / "postgres.dump", snapshot="00000004-001762EB-1"
    )
    assert "--snapshot" in args
    assert args[args.index("--snapshot") + 1] == "00000004-001762EB-1"
    assert "--enable-row-security" in args


def test_invalid_snapshot_identifier_is_rejected(tmp_path: Path) -> None:
    cfg = _config(tmp_path)
    with pytest.raises(backup.BackupError) as exc:
        backup._source_dump_args(
            cfg, tmp_path / "postgres.dump", snapshot="000; DROP TABLE x"
        )
    assert exc.value.code == "snapshot_invalid"
