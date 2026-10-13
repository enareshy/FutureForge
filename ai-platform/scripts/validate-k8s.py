#!/usr/bin/env python3
"""Static validation for the Kubernetes manifests.

This is a safety net for environments without `kubectl`/`kustomize`. It is not
a replacement for a real server-side dry run; it checks the structural rules
this platform relies on:

* every manifest has apiVersion/kind/metadata.name;
* workload containers declare resource requests/limits and probes;
* pods run as non-root with privilege escalation disabled and all caps dropped;
* NetworkPolicies declare a podSelector and policyTypes;
* Ingresses terminate TLS.

Exit code is non-zero if any check fails.
"""
from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
K8S_DIR = ROOT / "infrastructure" / "kubernetes"

errors: list[str] = []


def fail(path: Path, message: str) -> None:
    errors.append(f"{path.relative_to(ROOT)}: {message}")


def iter_documents(path: Path):
    try:
        with path.open("r", encoding="utf-8") as handle:
            for doc in yaml.safe_load_all(handle):
                if doc is not None:
                    yield doc
    except yaml.YAMLError as exc:  # pragma: no cover - reported as a failure
        fail(path, f"YAML parse error: {exc}")


def check_kustomization(path: Path, doc: dict) -> None:
    if doc.get("kind") != "Kustomization":
        fail(path, "expected kind: Kustomization")
    resources = doc.get("resources")
    if not isinstance(resources, list) or not resources:
        fail(path, "kustomization must list resources")


def check_metadata(path: Path, doc: dict) -> None:
    if not doc.get("apiVersion"):
        fail(path, f"{doc.get('kind', '?')} missing apiVersion")
    if not doc.get("kind"):
        fail(path, "manifest missing kind")
    name = (doc.get("metadata") or {}).get("name")
    if not name:
        fail(path, f"{doc.get('kind', '?')} missing metadata.name")


def check_pod_spec(path: Path, doc: dict, spec: dict) -> None:
    kind = doc.get("kind")
    pod_security = spec.get("securityContext") or {}
    containers = (spec.get("containers") or []) + (spec.get("initContainers") or [])
    if not containers:
        fail(path, f"{kind} has no containers")
    for container in containers:
        cname = container.get("name", "?")
        if not container.get("resources"):
            fail(path, f"{kind}/{cname} missing resources requests/limits")
        sec = container.get("securityContext") or {}
        if sec.get("allowPrivilegeEscalation") is not False:
            fail(path, f"{kind}/{cname} must set allowPrivilegeEscalation: false")
        if not (sec.get("capabilities") or {}).get("drop"):
            fail(path, f"{kind}/{cname} must drop capabilities")
        is_job = kind == "Job"
        if not is_job:
            if "readinessProbe" not in container:
                fail(path, f"{kind}/{cname} missing readinessProbe")
            if "livenessProbe" not in container:
                fail(path, f"{kind}/{cname} missing livenessProbe")
    # Non-root is satisfied at pod level or on each container.
    pod_nonroot = pod_security.get("runAsNonRoot") is True
    if not pod_nonroot and not all(
        (c.get("securityContext") or {}).get("runAsNonRoot") is True for c in containers
    ):
        fail(path, f"{kind} must run as non-root")


def check_document(path: Path, doc: dict) -> None:
    kind = doc.get("kind")
    if path.name.startswith("kustomization"):
        check_kustomization(path, doc)
        return
    # Overlay strategic-merge patch fragments are partial documents; validate
    # them for metadata only.
    if "patch" in path.name:
        check_metadata(path, doc)
        return
    check_metadata(path, doc)
    if kind == "Deployment":
        check_pod_spec(path, doc, doc["spec"]["template"]["spec"])
    elif kind == "Job":
        check_pod_spec(path, doc, doc["spec"]["template"]["spec"])
    elif kind == "NetworkPolicy":
        spec = doc["spec"]
        if "podSelector" not in spec:
            fail(path, "NetworkPolicy missing podSelector")
        if not spec.get("policyTypes"):
            fail(path, "NetworkPolicy missing policyTypes")
    elif kind == "Ingress":
        if not doc["spec"].get("tls"):
            fail(path, "Ingress must terminate TLS")


def main() -> int:
    if not K8S_DIR.is_dir():
        print(f"no kubernetes directory at {K8S_DIR}", file=sys.stderr)
        return 1
    files = sorted(K8S_DIR.rglob("*.yaml")) + sorted(K8S_DIR.rglob("*.yml"))
    count = 0
    for path in files:
        for doc in iter_documents(path):
            if not isinstance(doc, dict):
                continue
            check_document(path, doc)
            count += 1
    if errors:
        print("Kubernetes manifest validation FAILED:")
        for err in errors:
            print(f"  - {err}")
        return 1
    print(f"Kubernetes manifest validation OK ({count} documents in {len(files)} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
