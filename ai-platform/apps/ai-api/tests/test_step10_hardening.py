"""Step 10 hardening: batched visibility filtering (N+1 removal).

These tests pin the security *and* performance contract of the batched
readability helpers introduced in Step 10:

* filtering semantics are identical to the per-row ``_readable`` check
  (archived/deleted, classification ceiling and ACL are still enforced per row);
* a list request performs exactly one governance-policy lookup regardless of
  page size (previously one lookup per row).

Everything runs against the in-memory repository; the counting wrapper only
observes repository calls and does not change behaviour.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import get_ai_repository, get_principal
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.main import create_app
from ai_api.security.policies import Principal

API = "/api/v1/ai"
TENANT = 1
POWER_USER = frozenset({"*:*"})
# Non-superuser reader: may list product items, but ACL/ceiling filtering must
# still apply (a `*:*` principal is a platform superuser and bypasses ACLs).
READER = frozenset({"iam.pdm.items:read"})


class CountingRepository(InMemoryAiRepository):
    """In-memory repository that counts governance-policy lookups."""

    def __init__(self) -> None:
        super().__init__()
        self.policy_calls = 0

    async def get_governance_policy(self, tenant_id: int):
        self.policy_calls += 1
        return await super().get_governance_policy(tenant_id)


def _principal(
    tenant_id: int = TENANT,
    permissions: frozenset[str] = POWER_USER,
) -> Principal:
    return Principal(
        user_id="tester",
        username="tester",
        tenant_id=tenant_id,
        permissions=permissions,
        actor_id=7,
    )


@contextmanager
def _client(
    repository: InMemoryAiRepository,
    permissions: frozenset[str] = POWER_USER,
) -> Iterator[TestClient]:
    deps_module._rate_limiters.clear()
    app = create_app()
    app.dependency_overrides[get_ai_repository] = lambda: repository
    app.dependency_overrides[get_principal] = lambda: _principal(
        permissions=permissions
    )
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


def _item(client: TestClient, key: str, **overrides) -> dict:
    payload = {"item_type": "part", "item_key": key, "name": key, **overrides}
    response = client.post(f"{API}/products/items", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def test_product_list_does_not_double_query_governance_policy() -> None:
    repository = CountingRepository()
    with _client(repository) as client:
        for i in range(25):
            _item(client, f"PART-{i}")

        repository.policy_calls = 0
        response = client.get(f"{API}/products/items?limit=25")
        assert response.status_code == 200, response.text
        assert len(response.json()["items"]) == 25
        # One policy lookup for the page, not one per row.
        assert repository.policy_calls == 1


def test_batched_visibility_still_applies_acl_and_ceiling() -> None:
    repository = CountingRepository()
    # Seed as a superuser (needs write), read back as a non-superuser reader.
    with _client(repository) as client:
        _item(client, "OPEN-1")
        _item(client, "SECRET-1", acl={"users": ["someone-else"]})
        _item(client, "CLASSIFIED-1", classification="restricted")

    with _client(repository, permissions=READER) as reader:
        repository.policy_calls = 0
        response = reader.get(f"{API}/products/items?limit=25")
        assert response.status_code == 200, response.text
        keys = {item["item_key"] for item in response.json()["items"]}
        # The default tenant ceiling is "internal"; a "restricted" record is
        # filtered, and the ACL on SECRET-1 excludes this principal.
        assert "OPEN-1" in keys
        assert "SECRET-1" not in keys
        assert "CLASSIFIED-1" not in keys
        assert repository.policy_calls == 1


def test_bom_structure_visibility_is_batched() -> None:
    repository = CountingRepository()
    with _client(repository) as client:
        parent = _item(client, "ASSY", item_type="product")
        revision = client.post(
            f"{API}/products/items/{parent['id']}/revisions", json={"revision": "A"}
        )
        assert revision.status_code == 201, revision.text
        header = client.post(
            f"{API}/boms", json={"bom_type": "EBOM", "bom_key": "EBOM-BATCH"}
        )
        assert header.status_code == 201, header.text
        for i in range(15):
            child = _item(client, f"COMP-{i}")
            child_rev = client.post(
                f"{API}/products/items/{child['id']}/revisions",
                json={"revision": "A"},
            )
            assert child_rev.status_code == 201, child_rev.text
            line = client.post(
                f"{API}/boms/{header.json()['id']}/lines",
                json={
                    "parent_revision_id": revision.json()["id"],
                    "child_item_id": child["id"],
                    "quantity": 1,
                },
            )
            assert line.status_code == 201, line.text

        repository.policy_calls = 0
        structure = client.get(
            f"{API}/boms/{header.json()['id']}/structure?max_depth=1&limit=100"
        )
        assert structure.status_code == 200, structure.text
        assert structure.json()["total"] == 15
        # Structure performs a small constant number of policy lookups for the
        # whole page rather than one per line (plus header/revision lookups).
        assert repository.policy_calls <= 3


@pytest.mark.parametrize("path", ["manufacturing/plants", "quality/issues"])
def test_other_module_lists_batch_policy_lookup(path: str) -> None:
    repository = CountingRepository()
    with _client(repository) as client:
        if path.startswith("manufacturing"):
            for i in range(10):
                response = client.post(
                    f"{API}/manufacturing/plants", json={"plant_key": f"P-{i}"}
                )
                assert response.status_code == 201, response.text
        else:
            for i in range(10):
                response = client.post(
                    f"{API}/quality/issues",
                    json={"issue_key": f"I-{i}", "title": f"I-{i}"},
                )
                assert response.status_code == 201, response.text

        repository.policy_calls = 0
        listing = client.get(f"{API}/{path}?limit=10")
        assert listing.status_code == 200, listing.text
        assert len(listing.json()["items"]) == 10
        assert repository.policy_calls == 1


def test_stale_feature_value_is_flagged() -> None:
    """A feature value past its freshness window must be surfaced as stale.

    This pins the reliability contract: decisioning must never treat expired
    evidence as fresh (previously only the fresh branch was covered).
    """

    from datetime import UTC, datetime, timedelta

    repository = CountingRepository()
    with _client(repository) as client:
        created = client.post(
            f"{API}/predictive-intelligence/features",
            json={"feature_key": "defect_rate", "name": "Defect rate", "data_type": "number"},
        )
        assert created.status_code == 201, created.text
        item = _item(client, "PN-STALE")

        observed = datetime.now(UTC) - timedelta(days=30)
        recorded = client.post(
            f"{API}/predictive-intelligence/feature-values",
            json={
                "feature_key": "defect_rate",
                "entity_type": "product_item",
                "entity_id": item["id"],
                "value": 3.5,
                "observed_at": observed.isoformat(),
            },
        )
        assert recorded.status_code == 201, recorded.text
        assert recorded.json()["stale"] is True

        values = client.get(
            f"{API}/predictive-intelligence/feature-values?feature_key=defect_rate"
        )
        assert values.status_code == 200, values.text
        assert values.json()["items"][0]["stale"] is True
