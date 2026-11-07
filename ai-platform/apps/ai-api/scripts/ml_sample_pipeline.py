#!/usr/bin/env python3
"""Sample training / evaluation / inference pipeline for the AI platform (Phase 11).

This is a reference workflow, deliberately split into three separate commands so
that training, evaluation, and inference never happen implicitly:

    train     generate synthetic data, fit a model, log an experiment run, and
              register a model version through the platform API
    evaluate  load a registered artifact and score a held-out synthetic set,
              recording honest evaluation results (no fabricated metrics)
    infer     load a registered artifact and score a single sample

Everything is standard-library only (a tiny logistic-regression implementation
is included), so the sample runs without scikit-learn. If scikit-learn *is*
installed it is used instead, and the chosen backend is recorded in the run.

The data is synthetic and clearly labelled as such (``synthetic: true``) in the
run's dataset reference and in the model version's validation block. No claim is
made that any model here is useful for a real manufacturing outcome.

Usage:
    python ml_sample_pipeline.py train    --api http://127.0.0.1:8000 --token "$AI_SESSION_TOKEN"
    python ml_sample_pipeline.py evaluate --model-id 1 --version 1 ...
    python ml_sample_pipeline.py infer    --model-id 1 --version 1 --features 0.2,...
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DEFAULT_API = os.environ.get("AI_API_BASE", "http://127.0.0.1:8000")
DEFAULT_ARTIFACT_DIR = Path(os.environ.get("AI_ML_ARTIFACT_DIR", "./ml-artifacts"))

EXPERIMENT_CODE = "sample-telemetry-anomaly"
MODEL_CODE = "sample-telemetry-anomaly"
EVALUATION_CODE = "sample-telemetry-holdout"


# --------------------------------------------------------------------------
# Minimal HTTP client (stdlib only)
# --------------------------------------------------------------------------
class ApiError(RuntimeError):
    pass


class Client:
    def __init__(self, base_url: str, token: str | None) -> None:
        self._base = base_url.rstrip("/")
        self._token = token or ""

    def _request(self, method: str, path: str, payload: dict[str, Any] | None) -> Any:
        url = f"{self._base}{path}"
        data = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("Content-Type", "application/json")
        if self._token:
            request.add_header("Authorization", f"Bearer {self._token}")
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                body = response.read()
                return json.loads(body) if body else None
        except urllib.error.HTTPError as exc:
            raise ApiError(f"{method} {path} -> {exc.code}: {exc.read().decode()[:400]}") from exc
        except urllib.error.URLError as exc:
            raise ApiError(f"{method} {path} failed: {exc.reason}") from exc

    def get(self, path: str) -> Any:
        return self._request("GET", path, None)

    def post(self, path: str, payload: dict[str, Any]) -> Any:
        return self._request("POST", path, payload)


# --------------------------------------------------------------------------
# Synthetic dataset (clearly labelled)
# --------------------------------------------------------------------------
@dataclass(slots=True)
class Dataset:
    features: list[list[float]]
    labels: list[int]

    @property
    def rows(self) -> int:
        return len(self.labels)


def _sigmoid(z: float) -> float:
    if z < -60:
        return 0.0
    if z > 60:
        return 1.0
    return 1.0 / (1.0 + math.exp(-z))


def make_synthetic(rows: int, seed: int) -> Dataset:
    """Two-feature synthetic classification set.

    Label depends on a fixed linear rule plus noise; split is deterministic for a
    given seed so runs are reproducible.
    """
    rng = random.Random(seed)
    features: list[list[float]] = []
    labels: list[int] = []
    for _ in range(rows):
        x1 = rng.gauss(0.0, 1.0)
        x2 = rng.gauss(0.0, 1.0)
        logit = 1.4 * x1 - 0.9 * x2 + 0.2
        labels.append(1 if rng.random() < _sigmoid(logit) else 0)
        features.append([x1, x2])
    return Dataset(features=features, labels=labels)


# --------------------------------------------------------------------------
# Model: scikit-learn when available, else a stdlib logistic regression
# --------------------------------------------------------------------------
def _have_sklearn() -> bool:
    try:
        import sklearn  # noqa: F401

        return True
    except ImportError:
        return False


def train_model(dataset: Dataset, seed: int) -> dict[str, Any]:
    """Fit a model and return a JSON-serializable artifact bundle."""
    if _have_sklearn():
        from sklearn.linear_model import LogisticRegression

        model = LogisticRegression(random_state=seed, max_iter=500)
        model.fit(dataset.features, dataset.labels)
        return {
            "backend": "scikit-learn",
            "framework": "scikit-learn",
            "kind": "logistic_regression",
            "coef": [float(c) for c in model.coef_[0]],
            "intercept": float(model.intercept_[0]),
        }
    return {"backend": "stdlib", **_fit_logistic(dataset), "framework": "stdlib"}


def _fit_logistic(
    dataset: Dataset, epochs: int = 150, lr: float = 0.2, l2: float = 1e-4
) -> dict[str, Any]:
    n_features = len(dataset.features[0]) if dataset.features else 0
    weights = [0.0] * n_features
    bias = 0.0
    for _ in range(epochs):
        grad_w = [0.0] * n_features
        grad_b = 0.0
        for row, label in zip(dataset.features, dataset.labels, strict=True):
            pred = _sigmoid(
                sum(w * x for w, x in zip(weights, row, strict=False)) + bias
            )
            error = pred - label
            for i, x in enumerate(row):
                grad_w[i] += error * x
            grad_b += error
        scale = 1.0 / max(dataset.rows, 1)
        for i in range(n_features):
            weights[i] -= lr * (grad_w[i] * scale + l2 * weights[i])
        bias -= lr * grad_b * scale
    return {
        "kind": "logistic_regression",
        "coef": weights,
        "intercept": bias,
    }


def predict_proba(artifact: dict[str, Any], features: list[float]) -> float:
    coef = artifact["coef"]
    return _sigmoid(sum(w * x for w, x in zip(coef, features, strict=True)) + artifact["intercept"])


def score(artifact: dict[str, Any], dataset: Dataset) -> dict[str, float]:
    tp = tn = fp = fn = 0
    for row, label in zip(dataset.features, dataset.labels, strict=True):
        predicted = 1 if predict_proba(artifact, row) >= 0.5 else 0
        if predicted == 1 and label == 1:
            tp += 1
        elif predicted == 0 and label == 0:
            tn += 1
        elif predicted == 1 and label == 0:
            fp += 1
        else:
            fn += 1
    total = max(tp + tn + fp + fn, 1)
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return {
        "accuracy": (tp + tn) / total,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "support": float(total),
    }


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------
def _artifact_path(model_id: int, version: int) -> Path:
    DEFAULT_ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    return DEFAULT_ARTIFACT_DIR / f"model-{model_id}-v{version}.json"


def command_train(args: argparse.Namespace) -> int:
    client = Client(args.api, args.token)
    seed = args.seed
    dataset = make_synthetic(args.rows, seed)
    digest = sum(ord(c) for c in EXPERIMENT_CODE) % 10_000

    experiment = client.post(
        "/api/v1/ai/ml/experiments",
        {
            "code": EXPERIMENT_CODE,
            "name": "Sample telemetry anomaly",
            "problem_type": "classification",
            "tags": {"synthetic": True, "purpose": "reference-pipeline"},
        },
    )
    run = client.post(
        f"/api/v1/ai/ml/experiments/{experiment['id']}/runs",
        {
            "run_name": f"synthetic-{seed}",
            "params": {"rows": dataset.rows, "seed": seed, "lr": 0.2, "epochs": 150},
            "metrics": {},
            "training_config": {"algorithm": "logistic_regression", "l2": 1e-4},
            "dataset_ref": {
                "name": "synthetic-telemetry",
                "rows": dataset.rows,
                "seed": seed,
                "synthetic": True,
                "digest": digest,
            },
            "code_version": "sample-v1",
        },
    )

    artifact = train_model(dataset, seed)
    metrics = score(artifact, dataset)
    finished = client.post(
        f"/api/v1/ai/ml/runs/{run['id']}/finish",
        {"status": "finished", "metrics": metrics},
    )

    model = client.post(
        "/api/v1/ai/ml/models",
        {
            "code": MODEL_CODE,
            "name": "Sample telemetry anomaly",
            "problem_type": "classification",
            "framework": artifact["framework"],
            "task": "binary_classification",
        },
    )
    version = client.post(
        f"/api/v1/ai/ml/models/{model['id']}/versions",
        {
            "run_id": run["id"],
            "artifact_uri": str(_artifact_path(model["id"], 0)),
            "metrics": metrics,
            "parameters": artifact,
            "validation": {
                "synthetic": True,
                "in_sample": True,
                "note": "in-sample metrics on synthetic data; not a production claim",
            },
        },
    )
    path = _artifact_path(model["id"], version["version"])
    bundle = {**artifact, "model_id": model["id"], "version": version["version"]}
    path.write_text(json.dumps(bundle))
    client.post(
        f"/api/v1/ai/ml/models/{model['id']}/versions/{version['version']}/status",
        {"status": "staging"},
    )

    print(
        json.dumps(
            {
                "experiment_id": experiment["id"],
                "run_id": finished["id"],
                "run_uuid": finished["run_uuid"],
                "model_id": model["id"],
                "version": version["version"],
                "backend": artifact["backend"],
                "metrics": metrics,
                "artifact": str(path),
            },
            indent=2,
        )
    )
    return 0


def command_evaluate(args: argparse.Namespace) -> int:
    client = Client(args.api, args.token)
    path = _artifact_path(args.model_id, args.version)
    if not path.exists():
        raise SystemExit(f"artifact not found: {path} (run `train` first)")
    artifact = json.loads(path.read_text())

    dataset = make_synthetic(args.rows, args.seed + 1)
    metrics = score(artifact, dataset)

    evaluation = client.post(
        "/api/v1/ai/ml/evaluations",
        {
            "code": EVALUATION_CODE,
            "name": "Sample telemetry holdout",
            "kind": "retrieval",
            "config": {"synthetic": True, "rows": dataset.rows, "seed": args.seed + 1},
        },
    )
    for index, (row, label) in enumerate(
        zip(dataset.features, dataset.labels, strict=True)
    ):
        predicted = 1 if predict_proba(artifact, row) >= 0.5 else 0
        client.post(
            f"/api/v1/ai/ml/evaluations/{evaluation['id']}/results",
            {
                "case_id": f"case-{index}",
                "metrics": {"predicted": predicted, "label": label},
                "passed": predicted == label,
            },
        )
    print(
        json.dumps(
            {"evaluation_id": evaluation["id"], "holdout_rows": dataset.rows, "metrics": metrics},
            indent=2,
        )
    )
    return 0


def command_infer(args: argparse.Namespace) -> int:
    path = _artifact_path(args.model_id, args.version)
    if not path.exists():
        raise SystemExit(f"artifact not found: {path} (run `train` first)")
    artifact = json.loads(path.read_text())
    features = [float(part) for part in args.features.split(",") if part.strip()]
    probability = predict_proba(artifact, features)
    print(
        json.dumps(
            {
                "model_id": args.model_id,
                "version": args.version,
                "label": 1 if probability >= 0.5 else 0,
                "probability": probability,
            },
            indent=2,
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", default=DEFAULT_API, help="AI API base URL")
    parser.add_argument(
        "--token",
        default=os.environ.get("AI_SESSION_TOKEN", ""),
        help="enterprise session token (optional in development mode)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    train = sub.add_parser("train", help="train and register a model version")
    train.add_argument("--rows", type=int, default=1200)
    train.add_argument("--seed", type=int, default=1729)
    train.set_defaults(func=command_train)

    evaluate = sub.add_parser("evaluate", help="score a held-out synthetic set")
    evaluate.add_argument("--model-id", type=int, required=True)
    evaluate.add_argument("--version", type=int, required=True)
    evaluate.add_argument("--rows", type=int, default=25)
    evaluate.add_argument("--seed", type=int, default=1729)
    evaluate.set_defaults(func=command_evaluate)

    infer = sub.add_parser("infer", help="score a single sample")
    infer.add_argument("--model-id", type=int, required=True)
    infer.add_argument("--version", type=int, required=True)
    infer.add_argument("--features", required=True, help="comma-separated feature values")
    infer.set_defaults(func=command_infer)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except ApiError as exc:
        print(f"API error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
