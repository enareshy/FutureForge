"""Shared prompt-injection screening, abstention and audit.

Only finding counts and dispositions are persisted. Untrusted content is never
written to audit records or logs.
"""

from __future__ import annotations

from typing import Any

from ai_api.application.services.audit_service import AuditService
from ai_api.config.settings import Settings
from ai_api.domain.errors import AuthorizationError
from ai_api.domain.models.governance import GovernancePolicy
from ai_api.security.policies import Principal
from ai_api.security.prompt_safety import PromptGuard, PromptScan
from ai_api.telemetry.logging import request_id_var

PROMPT_INJECTION_ACTION = "ai.security.prompt_injection"


def blocking_enabled(policy: GovernancePolicy, settings: Settings) -> bool:
    """Return whether suspicious content must be blocked.

    Both the tenant policy and the operator floor must enable blocking, so a
    development operator can temporarily run detection-only without weakening
    the secure default.
    """

    return bool(policy.block_prompt_injection and settings.ai_prompt_injection_blocking)


async def _audit(
    audit: AuditService | None,
    principal: Principal,
    *,
    feature: str,
    model: str | None,
    scan: PromptScan,
    disposition: str,
    resource_type: str,
    resource_id: str | None = None,
    filtered: int = 0,
) -> None:
    if audit is None:
        return
    await audit.record(
        tenant_id=principal.tenant_id,
        actor_id=principal.actor_id,
        action=PROMPT_INJECTION_ACTION,
        resource_type=resource_type,
        resource_id=resource_id,
        outcome="denied" if disposition == "blocked" else disposition,
        request_id=request_id_var.get(),
        detail={
            "feature": feature,
            "model": model,
            "findings": len(scan.findings),
            "disposition": disposition,
            "filtered": filtered,
        },
    )


async def screen_input(
    audit: AuditService | None,
    principal: Principal,
    *,
    guard: PromptGuard,
    texts: list[str],
    feature: str,
    model: str | None,
    resource_type: str = "model",
    resource_id: str | None = None,
) -> PromptScan:
    """Block suspicious input, or record a detection when blocking is off."""

    scan = guard.scan(*texts)
    if not scan.suspicious:
        return scan

    if guard.block:
        await _audit(
            audit,
            principal,
            feature=feature,
            model=model,
            scan=scan,
            disposition="blocked",
            resource_type=resource_type,
            resource_id=resource_id,
        )
        raise AuthorizationError(
            "request rejected by content security policy",
            details={"findings": len(scan.findings)},
        )

    await _audit(
        audit,
        principal,
        feature=feature,
        model=model,
        scan=scan,
        disposition="detected",
        resource_type=resource_type,
        resource_id=resource_id,
    )
    return scan


async def filter_evidence(
    audit: AuditService | None,
    principal: Principal,
    *,
    guard: PromptGuard,
    items: list[dict[str, Any]],
    feature: str,
    model: str | None,
    resource_type: str = "knowledge",
    resource_id: str | None = None,
    content_key: str = "content",
) -> tuple[list[dict[str, Any]], PromptScan]:
    """Drop suspicious retrieved items when blocking is on (safe abstention)."""

    findings: set[str] = set()
    retained: list[dict[str, Any]] = []
    for item in items:
        text = str(item.get(content_key) or item.get("text") or "")
        item_scan = guard.scan(text)
        findings.update(item_scan.findings)
        if item_scan.suspicious and guard.block:
            continue
        retained.append(item)

    scan = PromptScan(findings=tuple(sorted(findings)))
    if scan.suspicious:
        filtered = len(items) - len(retained)
        await _audit(
            audit,
            principal,
            feature=feature,
            model=model,
            scan=scan,
            disposition="abstained" if guard.block else "detected",
            resource_type=resource_type,
            resource_id=resource_id,
            filtered=filtered,
        )
    return retained, scan
