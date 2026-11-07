"""Backup and restore-drill metrics derived from ``ai.backup_runs``.

The API's ``/metrics`` endpoint refreshes these gauges from the database before
rendering. Labels are intentionally limited to the run kind (``backup`` or
``restore_drill``); artifact paths, database names, tenant ids and error text
never become labels.
"""

from __future__ import annotations

from typing import Any

from prometheus_client import Gauge

from ai_api.telemetry.metrics import REGISTRY

LAST_RUN_STATUS = Gauge(
    "ai_backup_last_run_status",
    "Latest backup/drill run status: 1 succeeded, 0 failed.",
    ["kind"],
    registry=REGISTRY,
)
LAST_SUCCESS_TIMESTAMP = Gauge(
    "ai_backup_last_success_timestamp_seconds",
    "Unix timestamp of the latest successful run.",
    ["kind"],
    registry=REGISTRY,
)
LAST_DURATION = Gauge(
    "ai_backup_last_duration_seconds",
    "Duration of the latest run in seconds.",
    ["kind"],
    registry=REGISTRY,
)
LAST_ARTIFACT_SIZE = Gauge(
    "ai_backup_last_artifact_size_bytes",
    "Size of the artifact referenced by the latest run.",
    ["kind"],
    registry=REGISTRY,
)
LAST_INTEGRITY_OK = Gauge(
    "ai_backup_last_integrity_ok",
    "Whether the latest run verified artifact integrity (1 yes, 0 no).",
    ["kind"],
    registry=REGISTRY,
)
LAST_ENCRYPTED = Gauge(
    "ai_backup_last_encrypted",
    "Whether the latest backup artifact was encrypted (1 yes, 0 no).",
    ["kind"],
    registry=REGISTRY,
)

for _kind in ("backup", "restore_drill"):
    LAST_RUN_STATUS.labels(kind=_kind).set(1)
    LAST_SUCCESS_TIMESTAMP.labels(kind=_kind).set(0)
    LAST_DURATION.labels(kind=_kind).set(0)
    LAST_ARTIFACT_SIZE.labels(kind=_kind).set(0)
    LAST_INTEGRITY_OK.labels(kind=_kind).set(1)
    LAST_ENCRYPTED.labels(kind=_kind).set(0)


def record_backup_run(
    *,
    kind: str,
    succeeded: bool,
    finished_timestamp: float | None,
    duration_seconds: float | None,
    artifact_size_bytes: float | None,
    integrity_ok: bool | None,
    encrypted: bool | None,
) -> None:
    LAST_RUN_STATUS.labels(kind=kind).set(1 if succeeded else 0)
    if succeeded and finished_timestamp is not None:
        LAST_SUCCESS_TIMESTAMP.labels(kind=kind).set(finished_timestamp)
    LAST_DURATION.labels(kind=kind).set(max(0.0, duration_seconds or 0.0))
    LAST_ARTIFACT_SIZE.labels(kind=kind).set(max(0.0, artifact_size_bytes or 0.0))
    if integrity_ok is not None:
        LAST_INTEGRITY_OK.labels(kind=kind).set(1 if integrity_ok else 0)
    if encrypted is not None:
        LAST_ENCRYPTED.labels(kind=kind).set(1 if encrypted else 0)


async def refresh_backup_metrics(db: Any) -> None:
    rows = await db.fetch(
        """
        SELECT DISTINCT ON (kind)
               kind,
               status,
               finished_at,
               duration_seconds,
               artifact_size_bytes,
               integrity_ok,
               encrypted,
               max(finished_at) FILTER (WHERE status = 'succeeded')
                   OVER (PARTITION BY kind) AS last_success
        FROM ai.backup_runs
        WHERE status IN ('succeeded', 'failed')
        ORDER BY kind, started_at DESC
        """
    )
    for row in rows:
        succeeded = row["status"] == "succeeded"
        finished = row.get("finished_at")
        last_success = row.get("last_success") or (finished if succeeded else None)
        record_backup_run(
            kind=str(row["kind"]),
            succeeded=succeeded,
            finished_timestamp=last_success.timestamp() if last_success else None,
            duration_seconds=row.get("duration_seconds"),
            artifact_size_bytes=row.get("artifact_size_bytes"),
            integrity_ok=row.get("integrity_ok"),
            encrypted=row.get("encrypted"),
        )
