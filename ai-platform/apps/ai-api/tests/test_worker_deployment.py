from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

PLATFORM_ROOT = Path(__file__).resolve().parents[3]
K8S = PLATFORM_ROOT / "infrastructure" / "kubernetes"
COMPOSE = PLATFORM_ROOT / "compose.yaml"

WORKERS = {
    "ai-event-consumer": "ai_api.workers.event_consumer",
    "ai-reconciler": "ai_api.workers.reconciler",
    "ai-indexer": "ai_api.workers.indexer",
    "ai-agent-worker": "ai_api.workers.agent",
}


def _documents(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as handle:
        return [doc for doc in yaml.safe_load_all(handle) if doc]


def _worker_deployments() -> dict[str, dict]:
    docs = _documents(K8S / "base" / "worker-deployments.yaml")
    return {
        doc["metadata"]["name"]: doc
        for doc in docs
        if doc.get("kind") == "Deployment"
    }


def test_kustomization_includes_workers() -> None:
    base = _documents(K8S / "base" / "kustomization.yaml")[0]
    assert "worker-deployments.yaml" in base["resources"]


def test_each_worker_has_an_explicit_process_command() -> None:
    deployments = _worker_deployments()
    assert set(deployments) == set(WORKERS)
    for name, module in WORKERS.items():
        deployment = deployments[name]
        container = deployment["spec"]["template"]["spec"]["containers"][0]
        assert container["command"] == [
            "python",
            "-m",
            module,
            "--watch",
            "--metrics-port",
            "9100",
        ]
        assert "ai_api.main" not in " ".join(container["command"])
        assert container["ports"][0]["containerPort"] == 9100


def test_worker_replicas_match_coordination_guarantees() -> None:
    deployments = _worker_deployments()
    for deployment in deployments.values():
        assert deployment["spec"]["replicas"] == 1
        assert deployment["spec"]["strategy"]["type"] == "Recreate"


def test_worker_pods_are_least_privilege_and_probed() -> None:
    for deployment in _worker_deployments().values():
        pod = deployment["spec"]["template"]["spec"]
        assert pod["serviceAccountName"] == "ai-worker"
        assert pod["automountServiceAccountToken"] is False
        assert pod["terminationGracePeriodSeconds"] >= 60
        container = pod["containers"][0]
        assert container["resources"]["requests"]["cpu"]
        assert container["resources"]["limits"]["memory"]
        assert container["readinessProbe"]["httpGet"]["path"] == "/readyz"
        assert container["livenessProbe"]["httpGet"]["path"] == "/healthz"
        assert container["startupProbe"]["httpGet"]["path"] == "/healthz"
        assert container["securityContext"]["readOnlyRootFilesystem"] is True
        annotations = deployment["spec"]["template"]["metadata"]["annotations"]
        assert annotations["prometheus.io/scrape"] == "true"
        assert annotations["prometheus.io/port"] == "9100"
        env_sources = container["envFrom"]
        assert {"configMapRef": {"name": "ai-api-config"}} in env_sources
        assert {"secretRef": {"name": "ai-api-secrets"}} in env_sources


def test_worker_service_account_disables_token_mounting() -> None:
    docs = _documents(K8S / "base" / "serviceaccount.yaml")
    worker = next(doc for doc in docs if doc["metadata"]["name"] == "ai-worker")
    assert worker["automountServiceAccountToken"] is False


def test_config_disables_inline_indexing_and_unsafe_purge() -> None:
    config = _documents(K8S / "base" / "configmap.yaml")[0]["data"]
    assert config["AI_REPOSITORY"] == "postgres"
    assert config["AI_INGEST_INLINE"] == "false"
    assert config["AI_RECONCILE_ENABLED"] == "true"
    assert config["AI_RECONCILE_PURGE_ORPHANS"] == "false"
    assert config["AI_RECONCILE_DRY_RUN"] == "false"


def test_network_policies_allow_worker_backends_and_metrics_scrape() -> None:
    policies = {
        doc["metadata"]["name"]: doc
        for doc in _documents(K8S / "base" / "networkpolicy.yaml")
    }
    egress = policies["allow-worker-egress-backends"]["spec"]
    assert egress["podSelector"]["matchLabels"]["app.kubernetes.io/component"] == "worker"
    ports = {
        port["port"]
        for rule in egress["egress"]
        for port in rule.get("ports", [])
    }
    assert {5432, 8333, 9200, 9092, 4317, 3001} <= ports
    scrape = policies["allow-metrics-scrape"]["spec"]["ingress"][0]
    assert scrape["from"][0]["namespaceSelector"]["matchLabels"][
        "kubernetes.io/metadata.name"
    ] == "observability"
    assert {8000, 9100} <= {port["port"] for port in scrape["ports"]}


def test_compose_defines_independent_workers() -> None:
    docs = _documents(COMPOSE)
    services = docs[0]["services"]
    expected = {
        "event-consumer": "ai_api.workers.event_consumer",
        "reconciler": "ai_api.workers.reconciler",
        "indexer": "ai_api.workers.indexer",
        "agent": "ai_api.workers.agent",
    }
    for name, module in expected.items():
        service = services[name]
        assert module in service["command"]
        assert "--watch" in service["command"]
        assert "workers" in service["profiles"]
        assert service["healthcheck"]["test"]
        assert service["stop_grace_period"]
        assert "AI_METRICS_AUTH_TOKEN" in service["environment"]


def test_metrics_token_is_provisioned_for_api_workers_and_prometheus() -> None:
    secret = _documents(K8S / "base" / "secret.example.yaml")[0]["stringData"]
    assert "AI_METRICS_AUTH_TOKEN" in secret

    prometheus = (
        PLATFORM_ROOT / "infrastructure" / "monitoring" / "prometheus" / "prometheus.yml"
    ).read_text(encoding="utf-8")
    assert prometheus.count("credentials_file: /etc/prometheus/metrics-token") == 2

    nginx = (PLATFORM_ROOT / "apps" / "web-ai" / "deploy" / "nginx.conf.template").read_text(
        encoding="utf-8"
    )
    assert "location = /metrics" in nginx
    assert "return 404;" in nginx


def _render(target: str) -> list[dict]:
    kustomize = shutil.which("kustomize")
    if kustomize is None:
        pytest.skip("kustomize is not installed")
    result = subprocess.run(
        [kustomize, "build", str(K8S / target)],
        capture_output=True,
        text=True,
        check=True,
        timeout=120,
    )
    return [doc for doc in yaml.safe_load_all(result.stdout) if doc]


@pytest.mark.parametrize("target", ["base", "overlays/production"])
def test_effective_render_contains_workers(target: str) -> None:
    rendered = _render(target)
    deployments = {
        doc["metadata"]["name"]: doc
        for doc in rendered
        if doc.get("kind") == "Deployment"
    }
    assert set(WORKERS) <= set(deployments)
    for name in WORKERS:
        image = deployments[name]["spec"]["template"]["spec"]["containers"][0]["image"]
        assert image == "enterprise-ai-platform/ai-api:0.1.0"
