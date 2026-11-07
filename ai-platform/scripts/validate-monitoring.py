#!/usr/bin/env python3
"""Static validation for the Prometheus/Alertmanager files.

`promtool` is not available in every environment (it is absent from the agent
image and from the CI job's default toolchain), so this script checks the
structural invariants the platform actually depends on:

* every Prometheus rule has ``alert``/``expr``/``for``, a ``severity`` label and
  a non-empty ``summary``/``description``;
* the Kubernetes scrape config has an ``alerting`` block, a ``rule_files`` entry
  that exists, and bearer-protected ``ai-api``/``ai-workers`` jobs;
* the scrape targets match the Services declared in
  ``infrastructure/kubernetes/base/worker-services.yaml``;
* every Alertmanager route names a receiver that exists, and the script reports
  (does not fail on) receivers that have no integration, because a valid but
  non-delivering receiver is a known, documented limitation.

Exit code is non-zero only for structural errors.
"""
from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
PROM_DIR = ROOT / "infrastructure" / "monitoring" / "prometheus"
K8S_BASE = ROOT / "infrastructure" / "kubernetes" / "base"
OBS_K8S = ROOT / "infrastructure" / "kubernetes" / "monitoring"

errors: list[str] = []
warnings: list[str] = []


def load(path: Path) -> dict:
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = yaml.safe_load(handle)
    except yaml.YAMLError as exc:
        errors.append(f"{path.relative_to(ROOT)}: YAML parse error: {exc}")
        return {}
    if not isinstance(data, dict):
        errors.append(f"{path.relative_to(ROOT)}: expected a mapping at the top level")
        return {}
    return data


def check_rules(path: Path) -> None:
    data = load(path)
    groups = data.get("groups")
    if not isinstance(groups, list) or not groups:
        errors.append(f"{path.relative_to(ROOT)}: no rule groups")
        return
    seen: set[str] = set()
    for group in groups:
        name = group.get("name")
        if not name:
            errors.append(f"{path.relative_to(ROOT)}: rule group missing name")
        for rule in group.get("rules") or []:
            alert = rule.get("alert")
            if not alert:
                errors.append(f"{path.relative_to(ROOT)}/{name}: rule missing alert name")
                continue
            seen.add(alert)
            for key in ("expr", "for"):
                if not rule.get(key):
                    errors.append(f"{path.relative_to(ROOT)}/{name}: {alert} missing {key}")
            severity = (rule.get("labels") or {}).get("severity")
            if severity not in {"critical", "warning", "info"}:
                errors.append(f"{path.relative_to(ROOT)}/{name}: {alert} bad severity {severity!r}")
            annotations = rule.get("annotations") or {}
            for key in ("summary", "description"):
                if not annotations.get(key):
                    errors.append(
                        f"{path.relative_to(ROOT)}/{name}: {alert} missing annotation {key}"
                    )
    for required in ("AIBackupFailed", "AIBackupStale", "AIBackupIntegrityFailed",
                     "AIBackupUnencrypted", "AIRestoreDrillStale"):
        if required not in seen:
            errors.append(f"{path.relative_to(ROOT)}: missing alert {required}")


def worker_service_names() -> set[str]:
    names: set[str] = set()
    path = K8S_BASE / "worker-services.yaml"
    try:
        documents = yaml.safe_load_all(path.read_text(encoding="utf-8"))
        for doc in documents:
            if isinstance(doc, dict) and doc.get("kind") == "Service":
                names.add((doc.get("metadata") or {}).get("name", ""))
    except yaml.YAMLError as exc:
        errors.append(f"{path.relative_to(ROOT)}: YAML parse error: {exc}")
    if not names:
        errors.append("base/worker-services.yaml: no Services found")
    return names


def check_prometheus(path: Path) -> None:
    data = load(path)
    if not data.get("alerting", {}).get("alertmanagers"):
        errors.append(f"{path.relative_to(ROOT)}: no alerting.alertmanagers block")
    rule_files = data.get("rule_files") or []
    if not rule_files:
        errors.append(f"{path.relative_to(ROOT)}: no rule_files")
    for entry in rule_files:
        # Paths are container paths; compare only the file name to the canonical
        # repository file.
        if Path(entry).name != "backup-alerts.yml":
            errors.append(f"{path.relative_to(ROOT)}: unexpected rule file {entry}")
    jobs = {job.get("job_name"): job for job in data.get("scrape_configs") or []}
    for required in ("ai-api", "ai-workers"):
        job = jobs.get(required)
        if job is None:
            errors.append(f"{path.relative_to(ROOT)}: scrape job {required} missing")
            continue
        if not (job.get("authorization") or {}).get("credentials_file"):
            errors.append(f"{path.relative_to(ROOT)}: {required} has no bearer credentials_file")
        targets = [
            target
            for static in job.get("static_configs") or []
            for target in static.get("targets") or []
        ]
        if not targets:
            errors.append(f"{path.relative_to(ROOT)}: {required} has no targets")
    api_targets = [
        target
        for job in data.get("scrape_configs") or []
        if job.get("job_name") == "ai-api"
        for static in job.get("static_configs") or []
        for target in static.get("targets") or []
    ]
    if not any(":8000" in target for target in api_targets):
        errors.append(f"{path.relative_to(ROOT)}: ai-api target does not use port 8000")
    services = worker_service_names()
    worker_targets = [
        target
        for job in data.get("scrape_configs") or []
        if job.get("job_name") == "ai-workers"
        for static in job.get("static_configs") or []
        for target in static.get("targets") or []
    ]
    for target in worker_targets:
        host = target.split(":", 1)[0].split(".", 1)[0]
        if host not in services:
            errors.append(
                f"{path.relative_to(ROOT)}: worker target {host} has no Service in "
                "worker-services.yaml"
            )
    if len(worker_targets) != len(services):
        errors.append(
            f"{path.relative_to(ROOT)}: {len(worker_targets)} worker targets for "
            f"{len(services)} worker Services"
        )


def check_networkpath() -> None:
    """Prometheus -> Alertmanager must be admitted in BOTH directions.

    NetworkPolicy allows are per-direction. Missing the ingress allow on the
    Alertmanager pod makes ``default-deny`` drop the connection even though the
    Prometheus egress rule exists, so alerts never reach Alertmanager. This
    check is static: it verifies the policy objects exist with the right
    selectors and ports, not that a cluster enforces them.
    """
    path = OBS_K8S / "networkpolicy.yaml"
    if not path.is_file():
        errors.append("infrastructure/kubernetes/monitoring/networkpolicy.yaml: missing")
        return
    try:
        docs = [d for d in yaml.safe_load_all(path.read_text(encoding="utf-8")) if d]
    except yaml.YAMLError as exc:
        errors.append(f"{path.relative_to(ROOT)}: YAML parse error: {exc}")
        return

    denies_all = False
    egress_ok = False
    ingress_ok = False
    notify_egress_ok = False
    for doc in docs:
        if doc.get("kind") != "NetworkPolicy":
            continue
        spec = doc.get("spec") or {}
        selector = (spec.get("podSelector") or {}).get("matchLabels") or {}
        types = spec.get("policyTypes") or []
        if not selector and "Ingress" in types and "Egress" in types:
            denies_all = True
        if selector.get("app.kubernetes.io/name") == "prometheus" and "Egress" in types:
            for rule in spec.get("egress") or []:
                peers = rule.get("to") or []
                ports = {p.get("port") for p in rule.get("ports") or []}
                if 9093 in ports and any(
                    ((peer.get("podSelector") or {}).get("matchLabels") or {}).get(
                        "app.kubernetes.io/name"
                    )
                    == "alertmanager"
                    for peer in peers
                ):
                    egress_ok = True
        if selector.get("app.kubernetes.io/name") == "alertmanager" and "Ingress" in types:
            for rule in spec.get("ingress") or []:
                peers = rule.get("from") or []
                ports = {p.get("port") for p in rule.get("ports") or []}
                if 9093 in ports and any(
                    ((peer.get("podSelector") or {}).get("matchLabels") or {}).get(
                        "app.kubernetes.io/name"
                    )
                    == "prometheus"
                    for peer in peers
                ):
                    ingress_ok = True
        if selector.get("app.kubernetes.io/name") == "alertmanager" and "Egress" in types:
            for rule in spec.get("egress") or []:
                peers = rule.get("to") or []
                ports = {p.get("port") for p in rule.get("ports") or []}
                if 443 in ports and any(peer.get("ipBlock") for peer in peers):
                    notify_egress_ok = True

    if not denies_all:
        errors.append(f"{path.relative_to(ROOT)}: no default-deny policy for the namespace")
    if not egress_ok:
        errors.append(
            f"{path.relative_to(ROOT)}: no Prometheus egress rule to alertmanager:9093"
        )
    if not ingress_ok:
        errors.append(
            f"{path.relative_to(ROOT)}: no Alertmanager ingress rule from prometheus:9093; "
            "default-deny would drop Prometheus->Alertmanager alerts"
        )
    if not notify_egress_ok:
        errors.append(
            f"{path.relative_to(ROOT)}: no Alertmanager egress rule for notifications; "
            "default-deny would drop every receiver notification"
        )


def check_alertmanager(path: Path) -> None:
    data = load(path)
    receivers = {receiver.get("name") for receiver in data.get("receivers") or []}
    if not receivers:
        errors.append(f"{path.relative_to(ROOT)}: no receivers")
        return
    routes = [data.get("route") or {}]
    routes.extend((data.get("route") or {}).get("routes") or [])
    for route in routes:
        receiver = route.get("receiver")
        if receiver not in receivers:
            errors.append(
                f"{path.relative_to(ROOT)}: route references unknown receiver {receiver!r}"
            )
    integrations = 0
    for receiver in data.get("receivers") or []:
        for key in ("webhook_configs", "pagerduty_configs", "slack_configs",
                    "email_configs", "opsgenie_configs", "victorops_configs",
                    "pushover_configs", "sns_configs", "telegram_configs", "msteams_configs"):
            integrations += len(receiver.get(key) or [])
    if integrations == 0:
        warnings.append(
            f"{path.relative_to(ROOT)}: no receiver integration; alerts are visible in the "
            "Alertmanager UI but are not delivered to a human"
        )


def main() -> int:
    rules = PROM_DIR / "backup-alerts.yml"
    prometheus = PROM_DIR / "prometheus-kubernetes.yml"
    alertmanager = PROM_DIR / "alertmanager.yml"
    for path in (rules, prometheus, alertmanager):
        if not path.is_file():
            print(f"missing {path}", file=sys.stderr)
            return 1
    check_rules(rules)
    check_prometheus(prometheus)
    check_alertmanager(alertmanager)
    check_networkpath()
    for warning in warnings:
        print(f"WARN  - {warning}")
    if errors:
        print("Monitoring config validation FAILED:")
        for error in errors:
            print(f"  - {error}")
        return 1
    print("Monitoring config validation OK (rules, scrape jobs, routes, network path)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
