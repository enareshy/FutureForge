from __future__ import annotations

import pytest

from ai_api.application.reliability import (
    CircuitBreaker,
    CircuitOpenError,
    CircuitState,
    RateLimiter,
    RetryPolicy,
    call_with_retry,
)
from ai_api.domain.errors import ProviderError, RateLimitError


async def test_retry_succeeds_after_transient_failures() -> None:
    calls = {"count": 0}

    async def flaky() -> str:
        calls["count"] += 1
        if calls["count"] < 3:
            raise ProviderError("transient")
        return "ok"

    delays: list[float] = []

    async def fake_sleep(delay: float) -> None:
        delays.append(delay)

    result = await call_with_retry(
        flaky,
        policy=RetryPolicy(attempts=3, base_delay_seconds=0.1, max_delay_seconds=1.0),
        sleep=fake_sleep,
    )

    assert result == "ok"
    assert calls["count"] == 3
    assert len(delays) == 2


async def test_retry_exhausts_and_reraises() -> None:
    async def always_fail() -> str:
        raise ProviderError("nope")

    async def fake_sleep(_: float) -> None:
        return None

    with pytest.raises(ProviderError):
        await call_with_retry(
            always_fail,
            policy=RetryPolicy(attempts=2, base_delay_seconds=0.01),
            sleep=fake_sleep,
        )


def test_circuit_breaker_opens_then_half_opens() -> None:
    now = {"t": 0.0}
    breaker = CircuitBreaker(provider="p", threshold=2, reset_seconds=10.0, clock=lambda: now["t"])

    async def scenario() -> None:
        assert breaker.state is CircuitState.closed
        await breaker.before_call()
        await breaker.record_failure()
        await breaker.before_call()
        await breaker.record_failure()
        assert breaker.state is CircuitState.open

        with pytest.raises(CircuitOpenError):
            await breaker.before_call()

        now["t"] = 11.0
        await breaker.before_call()
        assert breaker.state is CircuitState.half_open
        await breaker.record_success()
        assert breaker.state is CircuitState.closed

    import asyncio

    asyncio.run(scenario())


async def test_rate_limiter_blocks_when_exhausted() -> None:
    limiter = RateLimiter(rate_per_minute=1, clock=lambda: 0.0)
    await limiter.acquire()
    with pytest.raises(RateLimitError):
        await limiter.acquire()


async def test_readiness_ping_revalidates_cached_pool() -> None:
    from ai_api.config.settings import get_settings
    from ai_api.infrastructure.db.database import PostgresDatabase

    db = PostgresDatabase(get_settings())

    class _BrokenPool:
        async def fetchval(self, _query: str) -> None:
            raise ConnectionError("pool is gone")

    db._pool = _BrokenPool()  # type: ignore[assignment]
    with pytest.raises(ConnectionError):
        await db.ping()

