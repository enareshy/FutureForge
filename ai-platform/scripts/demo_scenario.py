#!/usr/bin/env python3
"""Walk the connected customer demonstration scenario end to end.

This drives the isolated demo tenant through the single connected business
scenario used for the Step 12 customer demonstration and controlled pilot:

    Engineering change -> BOM revision -> manufacturing/quality traceability
    -> predictive risk -> agent investigation -> human approval -> audit

It talks only to the public HTTP API of a demo environment (never the database,
never a shared/live environment) and prints a concise, reviewable transcript of
the evidence at each step. It is read-mostly: it reuses the objects created by
``seed_demo.py`` and creates at most a short-lived demo execution.

Usage:
    AI_DEMO_API_BASE=http://127.0.0.1:18021/api/v1/ai \
    AI_DEMO_TOKEN=demo-token \
    python3 scripts/demo_scenario.py

Exit code 0 means every step of the scenario produced the expected evidence.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any

API_BASE = os.environ.get(
    "AI_DEMO_API_BASE", "http://127.0.0.1:18021/api/v1/ai"
).rstrip("/")
TOKEN = os.environ.get("AI_DEMO_TOKEN", "demo-token")
RETRY_STATUSES = {429, 502, 503, 504}
MAX_RETRIES = 6

CHECKS: list[tuple[str, bool, str]] = []


class ApiError(RuntimeError):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message


def _request(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    data = None
    headers = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{API_BASE}{path}", data=data, method=method)
    for key, value in headers.items():
        req.add_header(key, value)
    attempt = 0
    while True:
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = resp.read()
                return json.loads(payload) if payload else None
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            try:
                detail = json.loads(raw).get("error", {})
                code = detail.get("code", "http_error")
                message = detail.get("message", raw.decode("utf-8", "replace"))
            except (ValueError, AttributeError):
                code = "http_error"
                message = raw.decode("utf-8", "replace")
            if exc.code in RETRY_STATUSES and attempt < MAX_RETRIES:
                attempt += 1
                delay = float(exc.headers.get("Retry-After") or 0) or min(
                    30.0, 2.0**attempt
                )
                time.sleep(delay)
                continue
            raise ApiError(exc.code, code, message) from exc


def get(path: str) -> Any:
    return _request("GET", path)


def post(path: str, body: dict[str, Any] | None = None) -> Any:
    return _request("POST", path, body or {})


def check(label: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((label, ok, detail))
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {label}" + (f" - {detail}" if detail else ""))


def find(items: list[dict[str, Any]], key: str, value: Any) -> dict[str, Any] | None:
    return next((row for row in items if row.get(key) == value), None)


def as_items(payload: Any) -> list[dict[str, Any]]:
    """Normalise an endpoint that may return a bare list or a paged envelope."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        return payload.get("items", [])
    return []


def section(title: str) -> None:
    print(f"\n=== {title} ===")


def main() -> int:
    print(f"Connected demo scenario against {API_BASE}")

    # 1. Product and revision context -------------------------------------
    section("1. Product and revision")
    products = as_items(get("/products/items?query=DEMO-ASM-PUMP-100&limit=10"))
    pump = find(products, "item_key", "DEMO-ASM-PUMP-100")
    check("demo product exists", pump is not None, pump.get("name") if pump else "")
    if pump is None:
        return _finish()
    product_id = pump["id"]
    revisions = as_items(get(f"/products/revisions?item_id={product_id}"))
    check("product has revisions", bool(revisions), f"{len(revisions)} revisions")

    # 2. EBOM and MBOM ----------------------------------------------------
    section("2. EBOM and MBOM")
    boms = as_items(get("/boms?query=PUMP"))
    ebom = next((b for b in boms if b.get("bom_type") == "EBOM"), None)
    mbom = next((b for b in boms if b.get("bom_type") == "MBOM"), None)
    check("EBOM present", ebom is not None)
    check("MBOM present", mbom is not None)
    if not ebom or not mbom:
        return _finish()

    # 3. EBOM -> MBOM transformation evidence -----------------------------
    section("3. EBOM to MBOM difference")
    compare = post(
        "/boms/compare",
        {"left_header_id": ebom["id"], "right_header_id": mbom["id"]},
    )
    summary = compare.get("summary", {})
    check(
        "BOMs differ (manufacturing substitution)",
        summary.get("added", 0) > 0 or summary.get("removed", 0) > 0,
        json.dumps(summary),
    )

    # 4. Manufacturing context -------------------------------------------
    section("4. Manufacturing context")
    process = find(
        as_items(get("/manufacturing/processes?query=DEMO-PROC-PUMP-ASSY")),
        "process_key",
        "DEMO-PROC-PUMP-ASSY",
    )
    check("assembly process present", process is not None)
    if process:
        operations = as_items(get(f"/manufacturing/operations?process_id={process['id']}"))
        check("process has operations", bool(operations), f"{len(operations)} operations")

    # 5. Quality issue cluster -------------------------------------------
    section("5. Quality issue cluster")
    issues = as_items(get("/quality/issues?query=DEMO"))
    check("quality issues seeded", len(issues) >= 4, f"{len(issues)} issues")
    by_key = {i.get("issue_key"): i for i in issues}
    primary = by_key.get("DEMO-QI-2026-014")
    check("primary investigation issue present", primary is not None)
    repeats = get(f"/quality/repeat-issues?product_item_id={product_id}")
    check(
        "repeating failure detected",
        repeats.get("total", 0) >= 1,
        json.dumps(repeats.get("groups", [{}])[0].get("signature", "")),
    )

    # 6. Quality traceability --------------------------------------------
    if primary:
        section("6. Quality traceability")
        trace = get(f"/quality/issues/{primary['id']}/traceability")
        for link in ("product", "component", "process", "operation", "plant"):
            check(f"traceability links {link}", bool(trace.get(link)))

    # 7. Supplier quality -------------------------------------------------
    section("7. Supplier quality signal")
    supplier = get("/quality/supplier-quality")
    check("supplier quality rows present", bool(supplier.get("rows")))

    # 8. Engineering change and impact -----------------------------------
    section("8. Engineering change impact")
    change_hits = get("/graph/search?q=ECR-2026-007&limit=5")
    change_hits = change_hits if isinstance(change_hits, list) else change_hits.get(
        "items", []
    )
    change = find(change_hits, "stable_key", "demo-ecr-2026-007")
    check("engineering change entity present", change is not None)
    if change:
        impact = get(f"/graph/changes/{change['id']}/impact")
        check(
            "change has affected entities",
            bool(impact.get("affected")),
            f"{len(impact.get('affected', []))} affected",
        )

    # 9. Digital thread ---------------------------------------------------
    section("9. Digital thread")
    thread = get(f"/graph/products/{product_id}/digital-thread")
    sections = thread.get("sections", {})
    check("digital thread sections present", bool(sections), ", ".join(sections.keys()))

    # 10. Predictive risk -------------------------------------------------
    section("10. Predictive risk")
    preds = get(
        f"/predictive-intelligence/predictions?subject_type=product_item&subject_id={product_id}"
    )
    preds = as_items(preds)
    prediction = preds[0] if preds else None
    check("risk prediction present", prediction is not None)
    if prediction:
        check(
            "risk is elevated",
            prediction.get("risk_category") in {"high", "critical"},
            f"{prediction.get('risk_category')} ({prediction.get('score')})",
        )

    # 11. Recommendation --------------------------------------------------
    section("11. Recommendation")
    recs = get("/predictive-intelligence/recommendations")
    recs = as_items(recs)
    check("recommendation generated", bool(recs), f"{len(recs)} recommendations")

    # 12. Agent investigation --------------------------------------------
    section("12. Agent investigation (knowledge + predictive tools)")
    agents = get("/agents?limit=100")
    agents = as_items(agents)
    coordinator = find(agents, "code", "demo-change-coordinator")
    check("demo agent published", coordinator is not None)
    if coordinator:
        execution = post(
            "/agent-executions",
            {
                "agent_id": coordinator["id"],
                "input": {"query": "pump bearing defect risk"},
                "idempotency_key": f"demo-scenario-walk-{int(time.time())}",
            },
        )
        check(
            "agent execution queued",
            execution.get("status") in {"queued", "running"},
            f"execution {execution.get('id')}",
        )
        _print_worker_hint(execution.get("id"))

    # 13. Governance and audit -------------------------------------------
    section("13. Governance and audit")
    audit = as_items(get("/audit?limit=25"))
    actions = {row.get("action") for row in audit}
    check("agent activity audited", any(a and "agent" in a for a in actions))

    return _finish()


def _print_worker_hint(execution_id: int | None) -> None:
    if execution_id is None:
        return
    print(
        "  [info] Run the agent worker to execute this queued job, then re-check:\n"
        "         docker run --rm --add-host=host.docker.internal:host-gateway \\\n"
        "           -e AI_ENV=development -e AI_REPOSITORY=postgres \\\n"
        "           -e AI_DB_ROLE_PROFILE=worker -e AI_DB_EXPECTED_ROLE=ai_worker \\\n"
        "           -e POSTGRES_HOST=host.docker.internal -e POSTGRES_PORT=55432 \\\n"
        "           -e POSTGRES_DB=<demo-db> -e POSTGRES_USER=ai_worker \\\n"
        "           -e POSTGRES_PASSWORD=worker-test -e LLM_PROVIDER=mock \\\n"
        "           -e SEARCH_PROVIDER=postgres --entrypoint python <image> \\\n"
        "           -m ai_api.workers.agent --once"
    )


def _finish() -> int:
    total = len(CHECKS)
    passed = sum(1 for _, ok, _ in CHECKS if ok)
    print(f"\n{passed}/{total} scenario checks passed")
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
