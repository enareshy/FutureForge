#!/usr/bin/env python3
"""Seed the isolated demo/pilot environment with synthetic manufacturing data.

This script exercises the same public HTTP API a real client uses; it never
touches the database directly and never writes to shared or production
environments. It is idempotent: run it as many times as needed against a demo
tenant, and it reuses objects it created earlier by their stable key.

Usage:
    AI_DEMO_API_BASE=http://127.0.0.1:18021/api/v1/ai \
    AI_DEMO_TOKEN=demo-token \
    python3 scripts/seed_demo.py

Only synthetic, clearly fictitious data is created. See docs/DEMO_PILOT.md.
"""

from __future__ import annotations

import json
import os
import sys
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

DEMO_NOTE = "SYNTHETIC DEMO DATA - not a real customer record"


class ApiError(RuntimeError):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message


def _request(
    method: str, path: str, body: dict[str, Any] | None = None
) -> Any:
    data = None
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/json",
    }
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
        except urllib.error.HTTPError as exc:  # pragma: no cover - network path
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
                # Honour Retry-After when provided, else exponential backoff.
                delay = float(exc.headers.get("Retry-After") or 0) or min(
                    30.0, 2.0 ** attempt
                )
                time.sleep(delay)
                continue
            raise ApiError(exc.code, code, message) from exc


def get(path: str) -> Any:
    return _request("GET", path)


def post(path: str, body: dict[str, Any] | None = None) -> Any:
    return _request("POST", path, body or {})


def patch(path: str, body: dict[str, Any]) -> Any:
    return _request("PATCH", path, body)


def find_one(items: list[dict[str, Any]], key: str, value: Any) -> dict[str, Any] | None:
    return next((row for row in items if row.get(key) == value), None)


def ensure_item(
    key: str,
    *,
    item_type: str,
    name: str,
    description: str | None = None,
    **extra: Any,
) -> dict[str, Any]:
    page = get(f"/products/items?query={key}&limit=50")
    existing = find_one(page["items"], "item_key", key)
    if existing:
        return existing
    body = {
        "item_type": item_type,
        "item_key": key,
        "name": name,
        "description": description or f"{name} ({DEMO_NOTE})",
        "source_system": "demo.seed",
        **extra,
    }
    return post("/products/items", body)


def ensure_revision(item_id: int, revision: str, **extra: Any) -> dict[str, Any]:
    rows = get(f"/products/revisions?item_id={item_id}&limit=100")
    items = rows.get("items", rows) if isinstance(rows, dict) else rows
    existing = find_one(items, "revision", revision)
    if existing:
        return existing
    return post(
        f"/products/items/{item_id}/revisions",
        {"revision": revision, "lifecycle_status": "released", **extra},
    )


def ensure_bom(
    key: str, *, bom_type: str, root_item_id: int, root_revision_id: int, **extra: Any
) -> dict[str, Any]:
    page = get(f"/boms?query={key}&limit=50")
    existing = find_one(page["items"], "bom_key", key)
    if existing:
        return existing
    return post(
        "/boms",
        {
            "bom_type": bom_type,
            "bom_key": key,
            "name": key,
            "root_item_id": root_item_id,
            "root_revision_id": root_revision_id,
            "lifecycle_status": "released",
            "source_system": "demo.seed",
            **extra,
        },
    )


def ensure_line(
    header_id: int,
    *,
    parent_revision_id: int,
    child_item_id: int,
    child_revision_id: int | None,
    line_key: str,
    quantity: float = 1.0,
    **extra: Any,
) -> dict[str, Any]:
    rows = get(f"/boms/lines?header_id={header_id}&limit=200")
    items = rows.get("items", rows) if isinstance(rows, dict) else rows
    existing = find_one(items, "line_key", line_key)
    if existing:
        return existing
    return post(
        f"/boms/{header_id}/lines",
        {
            "parent_revision_id": parent_revision_id,
            "child_item_id": child_item_id,
            "child_revision_id": child_revision_id,
            "line_key": line_key,
            "quantity": quantity,
            **extra,
        },
    )


def ensure_plant(key: str, name: str, **extra: Any) -> dict[str, Any]:
    page = get(f"/manufacturing/plants?query={key}&limit=50")
    existing = find_one(page["items"], "plant_key", key)
    if existing:
        return existing
    return post(
        "/manufacturing/plants",
        {
            "plant_key": key,
            "name": name,
            "description": f"{name} ({DEMO_NOTE})",
            "site_code": key,
            "country": "DE",
            "timezone": "Europe/Berlin",
            **extra,
        },
    )


def ensure_line_entity(plant_id: int, key: str, name: str, **extra: Any) -> dict[str, Any]:
    page = get(f"/manufacturing/lines?plant_id={plant_id}&query={key}&limit=50")
    existing = find_one(page["items"], "line_key", key)
    if existing:
        return existing
    return post(
        "/manufacturing/lines",
        {"plant_id": plant_id, "line_key": key, "name": name, "capacity_per_hour": 12, **extra},
    )


def ensure_work_centre(
    plant_id: int, key: str, name: str, **extra: Any
) -> dict[str, Any]:
    page = get(f"/manufacturing/work-centres?plant_id={plant_id}&query={key}&limit=50")
    existing = find_one(page["items"], "work_centre_key", key)
    if existing:
        return existing
    return post(
        "/manufacturing/work-centres",
        {
            "plant_id": plant_id,
            "work_centre_key": key,
            "name": name,
            "work_centre_type": extra.pop("work_centre_type", "assembly"),
            **extra,
        },
    )


def ensure_process(key: str, name: str, **extra: Any) -> dict[str, Any]:
    page = get(f"/manufacturing/processes?query={key}&limit=50")
    existing = find_one(page["items"], "process_key", key)
    if existing:
        return existing
    return post(
        "/manufacturing/processes",
        {
            "process_type": extra.pop("process_type", "assembly"),
            "process_key": key,
            "name": name,
            "revision": "A",
            "lifecycle_status": "released",
            "source_system": "demo.seed",
            **extra,
        },
    )


def ensure_operation(
    process_id: int, key: str, name: str, **extra: Any
) -> dict[str, Any]:
    page = get(f"/manufacturing/operations?process_id={process_id}&limit=200")
    items = page.get("items", page) if isinstance(page, dict) else page
    existing = find_one(items, "operation_key", key)
    if existing:
        return existing
    return post(
        f"/manufacturing/processes/{process_id}/operations",
        {
            "operation_key": key,
            "name": name,
            "lifecycle_status": "released",
            **extra,
        },
    )


def ensure_issue(key: str, title: str, **extra: Any) -> dict[str, Any]:
    page = get(f"/quality/issues?query={key}&limit=50")
    existing = find_one(page["items"], "issue_key", key)
    if existing:
        return existing
    return post(
        "/quality/issues",
        {
            "issue_key": key,
            "title": title,
            "description": f"{title} ({DEMO_NOTE})",
            "detected_by": "demo.seed",
            "source_system": "demo.seed",
            **extra,
        },
    )


def ensure_action(issue_id: int, key: str, **extra: Any) -> dict[str, Any]:
    page = get(f"/quality/actions?quality_issue_id={issue_id}&limit=100")
    items = page.get("items", page) if isinstance(page, dict) else page
    existing = find_one(items, "action_key", key)
    if existing:
        return existing
    return post("/quality/actions", {"quality_issue_id": issue_id, "action_key": key, **extra})


def ensure_inspection(key: str, title: str, **extra: Any) -> dict[str, Any]:
    page = get("/quality/inspections?limit=200")
    existing = find_one(page["items"], "inspection_key", key)
    if existing:
        return existing
    return post(
        "/quality/inspections",
        {"inspection_key": key, "title": title, "status": "passed", **extra},
    )


def ensure_graph_entity(
    entity_type: str, stable_key: str, name: str, **extra: Any
) -> dict[str, Any]:
    result = get(f"/graph/search?q={stable_key}&limit=50")
    existing = find_one(result["items"], "stable_key", stable_key)
    if existing:
        return existing
    return post(
        "/graph/entities",
        {
            "entity_type": entity_type,
            "stable_key": stable_key,
            "name": name,
            "description": f"{name} ({DEMO_NOTE})",
            "source_system": "demo.seed",
            **extra,
        },
    )


def ensure_relationship(
    relationship_type: str, source_id: int, target_id: int, **extra: Any
) -> dict[str, Any]:
    page = get(f"/graph/relationships?entity_ids={source_id}&direction=outgoing&limit=200")
    items = page.get("items", page) if isinstance(page, dict) else page
    existing = next(
        (
            row
            for row in items
            if row.get("target_entity_id") == target_id
            and row.get("relationship_type") == relationship_type
        ),
        None,
    )
    if existing:
        return existing
    return post(
        "/graph/relationships",
        {
            "relationship_type": relationship_type,
            "source_entity_id": source_id,
            "target_entity_id": target_id,
            **extra,
        },
    )


def ensure_source(code: str, name: str) -> dict[str, Any]:
    page = get("/knowledge/sources?limit=100")
    existing = find_one(page["items"], "code", code)
    if existing:
        return existing
    return post("/knowledge/sources", {"code": code, "name": name, "kind": "manual"})


def seed_knowledge() -> dict[str, Any]:
    source = ensure_source("demo-engineering", "Demo Engineering Knowledge")
    documents = [
        {
            "external_id": "demo-bearing-torque",
            "title": "Bearing preload torque specification",
            "text": (
                "Apply 45 Nm preload torque to the main bearing retainer during "
                "pump assembly. Re-torque after 50 operating hours. Overtorque "
                "above 55 Nm has been linked to bearing race cracking."
            ),
        },
        {
            "external_id": "demo-seal-replacement",
            "title": "Pump seal replacement interval",
            "text": (
                "Replace the mechanical seal every 12 months or immediately on "
                "leak detection. Use only the approved Viton seal kit. Record the "
                "batch number in the maintenance log."
            ),
        },
        {
            "external_id": "demo-eco-process",
            "title": "Engineering change impact procedure",
            "text": (
                "When a seal material changes, engineering must review the EBOM, "
                "the MBOM and all downstream work instructions. Quality must "
                "confirm that incoming inspection plans cover the new material."
            ),
        },
    ]
    try:
        post(f"/knowledge/sources/{source['id']}/ingest", {"documents": documents})
    except ApiError as exc:
        # Idempotent reruns: identical documents are deduplicated, not errors.
        if exc.status < 400:
            raise
    return source


def seed_product_structure() -> dict[str, Any]:
    pump = ensure_item(
        "DEMO-ASM-PUMP-100",
        item_type="product",
        name="Hydraulic Pump Assembly 100",
        configuration={"family": "pump", "market": "industrial"},
    )
    pump_rev = ensure_revision(pump["id"], "B")
    housing = ensure_item("DEMO-PN-HOUSING", item_type="part", name="Pump housing")
    housing_rev = ensure_revision(housing["id"], "A")
    bearing = ensure_item("DEMO-PN-BEARING", item_type="part", name="Main bearing")
    bearing_rev = ensure_revision(bearing["id"], "A")
    seal = ensure_item("DEMO-PN-SEAL", item_type="part", name="Mechanical seal")
    seal_rev = ensure_revision(seal["id"], "A")
    seal_new = ensure_item(
        "DEMO-PN-SEAL-V2", item_type="part", name="Mechanical seal (Viton)"
    )
    seal_new_rev = ensure_revision(seal_new["id"], "A")
    impeller = ensure_item("DEMO-PN-IMPELLER", item_type="part", name="Impeller")

    ebom = ensure_bom(
        "DEMO-EBOM-PUMP-100",
        bom_type="EBOM",
        root_item_id=pump["id"],
        root_revision_id=pump_rev["id"],
    )
    ensure_line(
        ebom["id"],
        parent_revision_id=pump_rev["id"],
        child_item_id=housing["id"],
        child_revision_id=housing_rev["id"],
        line_key="10",
        quantity=1,
        find_number="10",
        sequence=10,
    )
    ensure_line(
        ebom["id"],
        parent_revision_id=pump_rev["id"],
        child_item_id=bearing["id"],
        child_revision_id=bearing_rev["id"],
        line_key="20",
        quantity=2,
        find_number="20",
        sequence=20,
    )
    ensure_line(
        ebom["id"],
        parent_revision_id=pump_rev["id"],
        child_item_id=seal["id"],
        child_revision_id=seal_rev["id"],
        line_key="30",
        quantity=1,
        find_number="30",
        sequence=30,
    )
    ensure_line(
        ebom["id"],
        parent_revision_id=pump_rev["id"],
        child_item_id=impeller["id"],
        child_revision_id=None,
        line_key="40",
        quantity=1,
        find_number="40",
        sequence=40,
    )

    mbom = ensure_bom(
        "DEMO-MBOM-PUMP-100",
        bom_type="MBOM",
        root_item_id=pump["id"],
        root_revision_id=pump_rev["id"],
        plant="DEMO-PLANT-DE",
    )
    ensure_line(
        mbom["id"],
        parent_revision_id=pump_rev["id"],
        child_item_id=housing["id"],
        child_revision_id=housing_rev["id"],
        line_key="10",
        quantity=1,
        find_number="10",
        sequence=10,
    )
    ensure_line(
        mbom["id"],
        parent_revision_id=pump_rev["id"],
        child_item_id=bearing["id"],
        child_revision_id=bearing_rev["id"],
        line_key="20",
        quantity=2,
        find_number="20",
        sequence=20,
    )
    ensure_line(
        mbom["id"],
        parent_revision_id=pump_rev["id"],
        child_item_id=seal_new["id"],
        child_revision_id=seal_new_rev["id"],
        line_key="30",
        quantity=1,
        find_number="30",
        sequence=30,
        attributes={"substituted_from": "DEMO-PN-SEAL", "reason": "material upgrade"},
    )

    return {
        "pump": pump,
        "pump_rev": pump_rev,
        "bearing": bearing,
        "seal": seal,
        "seal_new": seal_new,
        "ebom": ebom,
        "mbom": mbom,
    }


def seed_manufacturing(product: dict[str, Any]) -> dict[str, Any]:
    plant = ensure_plant("DEMO-PLANT-DE", "Demo Plant Stuttgart")
    line = ensure_line_entity(plant["id"], "DEMO-LINE-A", "Pump assembly line A")
    centre = ensure_work_centre(
        plant["id"], "DEMO-WC-ASSY", "Assembly work centre", line_id=line["id"]
    )
    process = ensure_process(
        "DEMO-PROC-PUMP-ASSY",
        "Pump assembly process",
        root_item_id=product["pump"]["id"],
        root_revision_id=product["pump_rev"]["id"],
        mbom_header_id=product["mbom"]["id"],
        plant_id=plant["id"],
        line_id=line["id"],
    )
    op10 = ensure_operation(
        process["id"],
        "OP-10",
        "Press-fit bearing",
        sequence=10,
        work_centre_id=centre["id"],
        plant_id=plant["id"],
        operation_type="value_add",
        cycle_minutes=12.0,
    )
    op20 = ensure_operation(
        process["id"],
        "OP-20",
        "Install mechanical seal",
        sequence=20,
        work_centre_id=centre["id"],
        plant_id=plant["id"],
        operation_type="value_add",
        cycle_minutes=9.0,
    )
    op30 = ensure_operation(
        process["id"],
        "OP-30",
        "Final leak inspection",
        sequence=30,
        work_centre_id=centre["id"],
        plant_id=plant["id"],
        operation_type="inspection",
        cycle_minutes=5.0,
    )
    try:
        post(
            "/manufacturing/work-instructions",
            {
                "process_id": process["id"],
                "operation_id": op10["id"],
                "instruction_key": "DEMO-WI-OP10",
                "title": "Bearing press-fit and preload",
                "instruction_type": "checklist",
                "lifecycle_status": "released",
                "document_ref": "demo-bearing-torque",
                "steps": [
                    {"step": 1, "text": "Clean bearing seat and verify dimensions."},
                    {"step": 2, "text": "Press-fit bearing to 45 Nm preload."},
                    {"step": 3, "text": "Record torque value in the build record."},
                ],
            },
        )
    except ApiError as exc:
        print(f"  skip work instruction: {exc}", file=sys.stderr)
    return {"plant": plant, "line": line, "centre": centre, "process": process,
            "op10": op10, "op20": op20, "op30": op30}


def seed_quality(product: dict[str, Any], mfg: dict[str, Any]) -> dict[str, Any]:
    issue = ensure_issue(
        "DEMO-QI-2026-014",
        "Bearing race cracking after overtorque",
        issue_type="nonconformance",
        severity="high",
        status="investigating",
        product_item_id=product["pump"]["id"],
        component_item_id=product["bearing"]["id"],
        process_id=mfg["process"]["id"],
        operation_id=mfg["op10"]["id"],
        plant_id=mfg["plant"]["id"],
        work_centre_id=mfg["centre"]["id"],
        supplier_ref="DEMO-SUP-BEARING",
        failure_code="CRACK",
        disposition="rework",
    )
    # A realistic cluster of related open issues on the same product turns a
    # single low-risk signal into an actionable, medium/high risk pattern that
    # warrants a recommendation. This is what makes the demo honest: the risk
    # is derived from the recorded quality history, not from a fabricated score.
    cluster = [
        ("DEMO-QI-2026-018", "Seal leak on final inspection", "high",
         "LEAK", mfg["op20"]["id"], "DEMO-SUP-SEAL"),
        ("DEMO-QI-2026-021", "Bearing race micro-crack (repeat)", "high",
         "CRACK", mfg["op10"]["id"], "DEMO-SUP-BEARING"),
        ("DEMO-QI-2026-023", "Housing bore out of tolerance", "critical",
         "TOLERANCE", mfg["op10"]["id"], "DEMO-SUP-HOUSING"),
    ]
    for key, title, severity, failure_code, operation_id, supplier in cluster:
        ensure_issue(
            key,
            title,
            issue_type="nonconformance",
            severity=severity,
            status="open",
            product_item_id=product["pump"]["id"],
            component_item_id=product["bearing"]["id"],
            process_id=mfg["process"]["id"],
            operation_id=operation_id,
            plant_id=mfg["plant"]["id"],
            work_centre_id=mfg["centre"]["id"],
            supplier_ref=supplier,
            failure_code=failure_code,
            disposition="sort",
        )
    try:
        post(
            f"/quality/issues/{issue['id']}/root-causes",
            {
                "classification": "process",
                "description": (
                    "Preload torque exceeded the 55 Nm limit when the torque "
                    "wrench calibration drifted."
                ),
                "is_hypothesis": True,
                "confidence": 0.72,
                "evidence": [{"type": "document", "ref": "demo-bearing-torque"}],
            },
        )
    except ApiError as exc:
        print(f"  skip root cause: {exc}", file=sys.stderr)
    try:
        post(
            f"/quality/issues/{issue['id']}/supplier-issues",
            {
                "supplier_ref": "DEMO-SUP-BEARING",
                "supplier_name": "Demo Bearing Supplier GmbH",
                "component_item_id": product["bearing"]["id"],
            },
        )
    except ApiError as exc:
        print(f"  skip supplier issue: {exc}", file=sys.stderr)
    action = ensure_action(
        issue["id"],
        "DEMO-CA-014",
        title="Recalibrate torque wrench and add second-person check",
        description="Recalibrate the wrench; add a second-person verification step to OP-10.",
        action_type="corrective",
        status="implemented",
        owner_user="demo.quality.engineer",
        effectiveness="pending",
    )
    ensure_inspection(
        "DEMO-INSP-014",
        "Incoming bearing race inspection",
        inspection_type="incoming",
        component_item_id=product["bearing"]["id"],
        plant_id=mfg["plant"]["id"],
        quality_issue_id=issue["id"],
        characteristic="Race surface hardness",
        sample_size=32,
        passed_count=31,
        failed_count=1,
        performed_by="demo.inspector",
    )
    return {"issue": issue, "action": action}


def seed_engineering_change(product: dict[str, Any]) -> dict[str, Any]:
    change = ensure_graph_entity(
        "change_request",
        "DEMO-ECR-2026-007",
        "Switch pump seal to Viton material",
        lifecycle_status="active",
    )
    pump_entity = None
    if product["pump"].get("graph_entity_id"):
        pump_entity = {"id": product["pump"]["graph_entity_id"]}
    else:
        pump_entity = ensure_graph_entity(
            "product", "DEMO-PUMP-ENTITY", product["pump"]["name"]
        )
    ensure_relationship("affects", change["id"], pump_entity["id"])
    return {"change": change, "pump_entity": pump_entity}


def seed_predictive(product: dict[str, Any], quality: dict[str, Any]) -> dict[str, Any]:
    prediction = post(
        "/predictive-intelligence/predictions",
        {
            "prediction_type": "defect_risk",
            "subject_type": "product_item",
            "subject_id": product["pump"]["id"],
            "subject_key": product["pump"]["item_key"],
            "observation_window_days": 180,
            "idempotency_key": "demo-prediction-pump-100",
        },
    )
    recommendation = None
    try:
        generated = post(
            "/predictive-intelligence/recommendations/generate",
            {"prediction_ids": [prediction["id"]]},
        )
        if generated:
            recommendation = generated[0]
    except ApiError as exc:
        print(f"  note: recommendation generation: {exc}", file=sys.stderr)
    return {"prediction": prediction, "recommendation": recommendation}


def seed_agent() -> dict[str, Any]:
    definition = {
        "system_instructions": (
            "Coordinate an engineering-change to quality investigation. Use only "
            "authorized read tools; propose actions for human review."
        ),
        "tools": ["knowledge.search", "predictive.risk_lookup"],
        "steps": [
            {
                "key": "search",
                "sequence": 1,
                "tool": "knowledge.search",
                "args": {"query": "{{query}}"},
                "depends_on": [],
            },
            {
                "key": "risk",
                "sequence": 2,
                "tool": "predictive.risk_lookup",
                "args": {
                    "prediction_type": "defect_risk",
                    "subject_type": "product_item",
                },
                "depends_on": [],
            },
        ],
    }
    page = get("/agents?limit=100")
    items = page if isinstance(page, list) else page.get("items", [])
    existing = find_one(items, "code", "demo-change-coordinator")
    if existing:
        return existing
    agent = post(
        "/agents",
        {
            "code": "demo-change-coordinator",
            "name": "Engineering Change Coordinator (Demo)",
            "description": "Coordinates an engineering change to quality investigation.",
            "kind": "workflow",
            "category": "engineering",
            "owner": "demo.seed",
            "definition": definition,
        },
    )
    published = post(f"/agents/{agent['id']}/publish", {})
    return published


def main() -> int:
    print(f"Seeding synthetic demo data via {API_BASE}")
    print("[1/7] knowledge")
    seed_knowledge()
    print("[2/7] product, revisions, EBOM, MBOM")
    product = seed_product_structure()
    print("[3/7] manufacturing plants, lines, operations, work instructions")
    mfg = seed_manufacturing(product)
    print("[4/7] quality issue, root cause, supplier, corrective action, inspection")
    quality = seed_quality(product, mfg)
    print("[5/7] engineering change and graph impact")
    change = seed_engineering_change(product)
    print("[6/7] predictive risk and recommendation")
    predictive = seed_predictive(product, quality)
    print("[7/7] agent definition")
    agent = seed_agent()

    summary = {
        "tenant": "demo (development identity)",
        "product_item_id": product["pump"]["id"],
        "product_item_key": product["pump"]["item_key"],
        "ebom_header_id": product["ebom"]["id"],
        "mbom_header_id": product["mbom"]["id"],
        "plant_id": mfg["plant"]["id"],
        "quality_issue_id": quality["issue"]["id"],
        "change_entity_id": change["change"]["id"],
        "prediction_id": predictive["prediction"]["id"],
        "recommendation_id": (
            predictive["recommendation"]["id"] if predictive["recommendation"] else None
        ),
        "agent_id": agent["id"],
    }
    print(json.dumps(summary, indent=2))
    print("Seed complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
