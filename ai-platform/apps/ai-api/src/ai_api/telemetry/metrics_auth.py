"""Authentication for Prometheus metric endpoints.

Metrics are not a public endpoint. Both the API and the worker health servers
require a bearer token before they render the Prometheus registry; an
unconfigured token fails closed instead of exposing the registry anonymously.

Only the fixed registration token is compared. Scalars are low-cardinality by
construction (see ``telemetry/metrics.py``), so the exposition does not carry
tenant ids, document content, prompts or secrets.
"""

from __future__ import annotations

import secrets


def metrics_auth_configured(token: str) -> bool:
    return bool(token.strip())


def metrics_authorized(authorization: str | None, token: str) -> bool:
    """Return true only for a non-empty bearer token matching the configured one."""
    expected = token.strip()
    if not expected or not authorization:
        return False
    scheme, separator, credentials = authorization.partition(" ")
    if not separator or scheme.strip().lower() != "bearer":
        return False
    presented = credentials.strip()
    if not presented:
        return False
    return secrets.compare_digest(presented.encode("utf-8"), expected.encode("utf-8"))
