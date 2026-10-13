"""Object storage for original uploaded documents (Stage 3).

Providers return opaque keys and never expose absolute paths or signed URLs to
clients. The default runtime provider is S3-compatible (SeaweedFS / MinIO / AWS
S3) using the existing ``S3_*`` settings; an in-memory provider backs tests and
local development. Both satisfy ``application.ports.ObjectStorage``.

``boto3`` is imported lazily so the module stays importable (and the memory
provider usable) when the S3 dependency is absent; the S3 provider fails closed
with ``ConfigurationError`` instead of silently returning no data.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import uuid
from datetime import UTC, datetime
from typing import Any

from ai_api.config.settings import Settings
from ai_api.domain.errors import ConfigurationError

_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9/_.\-]*$")
_FILENAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


def sanitize_filename(filename: str, *, default: str = "document") -> str:
    base = (filename or "").strip().replace("\\", "/").split("/")[-1]
    cleaned = _FILENAME_RE.sub("_", base).strip("._")
    if not cleaned:
        cleaned = default
    return cleaned[:128]


def validate_object_key(key: str) -> str:
    value = str(key or "")
    if (
        not value
        or not _KEY_RE.match(value)
        or ".." in value
        or value.startswith("/")
    ):
        raise ConfigurationError("invalid object storage key")
    return value


def build_object_key(
    tenant_id: int, filename: str, *, now: datetime | None = None
) -> str:
    """Deterministic, tenant-partitioned key for an uploaded original."""

    moment = now or datetime.now(UTC)
    safe = sanitize_filename(filename)
    return (
        f"knowledge/{int(tenant_id)}/{moment:%Y}/{moment:%m}/"
        f"{uuid.uuid4().hex}/{safe}"
    )


class InMemoryObjectStorage:
    """Process-local object storage for tests and single-process development."""

    backend = "memory"

    def __init__(self) -> None:
        self._objects: dict[str, tuple[bytes, str]] = {}

    async def put(self, key: str, data: bytes, *, content_type: str) -> None:
        self._objects[validate_object_key(key)] = (bytes(data), content_type)

    async def get(self, key: str) -> bytes | None:
        entry = self._objects.get(validate_object_key(key))
        return entry[0] if entry else None

    async def delete(self, key: str) -> None:
        self._objects.pop(validate_object_key(key), None)

    async def exists(self, key: str) -> bool:
        return validate_object_key(key) in self._objects

    async def status(self) -> dict[str, Any]:
        return {"backend": self.backend, "available": True, "objects": len(self._objects)}


class S3ObjectStorage:
    """S3-compatible object storage (SeaweedFS / MinIO / AWS S3)."""

    backend = "s3"

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._bucket = settings.s3_bucket
        self._client: Any | None = None

    def _ensure_client(self) -> Any:
        if self._client is not None:
            return self._client
        try:
            import boto3  # noqa: PLC0415 - optional dependency, imported lazily
        except ImportError as exc:  # pragma: no cover - depends on environment
            raise ConfigurationError(
                "S3 object storage requires the boto3 dependency",
                details={"reason": "missing_dependency"},
            ) from exc
        session = boto3.session.Session()
        self._client = session.client(
            "s3",
            endpoint_url=self._settings.s3_endpoint,
            region_name=self._settings.s3_region,
            aws_access_key_id=self._settings.s3_access_key_id.get_secret_value() or None,
            aws_secret_access_key=(
                self._settings.s3_secret_access_key.get_secret_value() or None
            ),
            config=boto3.session.Config(
                s3={"addressing_style": "path"}
                if self._settings.s3_force_path_style
                else {}
            ),
        )
        return self._client

    async def put(self, key: str, data: bytes, *, content_type: str) -> None:
        safe = validate_object_key(key)

        def _put() -> None:
            self._ensure_client().put_object(
                Bucket=self._bucket,
                Key=safe,
                Body=data,
                ContentType=content_type or "application/octet-stream",
            )

        await asyncio.to_thread(_put)

    async def get(self, key: str) -> bytes | None:
        safe = validate_object_key(key)

        def _get() -> bytes | None:
            client = self._ensure_client()
            try:
                response = client.get_object(Bucket=self._bucket, Key=safe)
            except client.exceptions.NoSuchKey:
                return None
            return response["Body"].read()

        return await asyncio.to_thread(_get)

    async def delete(self, key: str) -> None:
        safe = validate_object_key(key)

        def _delete() -> None:
            self._ensure_client().delete_object(Bucket=self._bucket, Key=safe)

        await asyncio.to_thread(_delete)

    async def exists(self, key: str) -> bool:
        safe = validate_object_key(key)

        def _exists() -> bool:
            client = self._ensure_client()
            try:
                client.head_object(Bucket=self._bucket, Key=safe)
                return True
            except client.exceptions.ClientError:
                return False

        return await asyncio.to_thread(_exists)

    async def status(self) -> dict[str, Any]:
        def _status() -> dict[str, Any]:
            client = self._ensure_client()
            try:
                client.head_bucket(Bucket=self._bucket)
                return {"backend": self.backend, "available": True, "bucket": self._bucket}
            except Exception as exc:  # noqa: BLE001 - reported, never raised
                return {
                    "backend": self.backend,
                    "available": False,
                    "bucket": self._bucket,
                    "error": str(exc)[:200],
                }

        try:
            return await asyncio.to_thread(_status)
        except ConfigurationError as exc:
            return {"backend": self.backend, "available": False, "error": str(exc)}


def content_checksum(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_object_storage(settings: Settings) -> InMemoryObjectStorage | S3ObjectStorage:
    if settings.ai_repository == "memory":
        return InMemoryObjectStorage()
    return S3ObjectStorage(settings)


__all__ = [
    "InMemoryObjectStorage",
    "S3ObjectStorage",
    "build_object_key",
    "build_object_storage",
    "content_checksum",
    "sanitize_filename",
    "validate_object_key",
]
