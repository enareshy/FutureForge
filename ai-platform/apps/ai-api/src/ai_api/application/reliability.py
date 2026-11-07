from __future__ import annotations

import asyncio
import random
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import TypeVar

from ai_api.domain.errors import ProviderError, RateLimitError, ServiceUnavailableError

T = TypeVar("T")


class CircuitOpenError(ServiceUnavailableError):
    code = "circuit_open"
    http_status = 503


class CircuitState(StrEnum):
    closed = "closed"
    open = "open"
    half_open = "half_open"


@dataclass(frozen=True)
class RetryPolicy:
    attempts: int = 3
    base_delay_seconds: float = 0.25
    max_delay_seconds: float = 2.0
    jitter: float = 0.1

    def delay_for(self, attempt: int) -> float:
        """Exponential backoff (attempt is 1-based) with bounded jitter."""
        backoff = min(self.max_delay_seconds, self.base_delay_seconds * (2 ** (attempt - 1)))
        return backoff + random.uniform(0.0, self.jitter * backoff)


async def call_with_retry(
    fn: Callable[[], Awaitable[T]],
    *,
    policy: RetryPolicy,
    retry_on: tuple[type[BaseException], ...] = (ProviderError, RateLimitError),
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> T:
    last_exc: BaseException | None = None
    for attempt in range(1, policy.attempts + 1):
        try:
            return await fn()
        except retry_on as exc:
            last_exc = exc
            if attempt >= policy.attempts:
                break
            await sleep(policy.delay_for(attempt))
    assert last_exc is not None
    raise last_exc


class CircuitBreaker:
    """Per-provider circuit breaker.

    Opens after `threshold` consecutive failures, rejects calls while open, and
    allows a single trial call after `reset_seconds` (half-open).
    """

    def __init__(
        self,
        *,
        provider: str,
        threshold: int = 5,
        reset_seconds: float = 30.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.provider = provider
        self._threshold = threshold
        self._reset_seconds = reset_seconds
        self._clock = clock
        self._failures = 0
        self._opened_at: float | None = None
        self._half_open = False
        self._lock = asyncio.Lock()

    @property
    def state(self) -> CircuitState:
        if self._opened_at is None:
            return CircuitState.closed
        if self._half_open:
            return CircuitState.half_open
        return CircuitState.open

    async def before_call(self) -> None:
        async with self._lock:
            if self._opened_at is None:
                return
            if self._clock() - self._opened_at >= self._reset_seconds:
                self._half_open = True
                return
            raise CircuitOpenError(
                "provider circuit is open",
                details={"provider": self.provider},
            )

    async def record_success(self) -> None:
        async with self._lock:
            self._failures = 0
            self._opened_at = None
            self._half_open = False

    async def record_failure(self) -> None:
        async with self._lock:
            self._failures += 1
            if self._failures >= self._threshold:
                self._opened_at = self._clock()
                self._half_open = False


class RateLimiter:
    """Async token-bucket limiter for outbound provider calls."""

    def __init__(
        self,
        *,
        rate_per_minute: int,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._capacity = float(rate_per_minute)
        self._refill_per_second = rate_per_minute / 60.0
        self._tokens = float(rate_per_minute)
        self._updated_at = clock()
        self._clock = clock
        self._lock = asyncio.Lock()

    async def acquire(self, tokens: int = 1) -> None:
        async with self._lock:
            now = self._clock()
            elapsed = now - self._updated_at
            self._tokens = min(self._capacity, self._tokens + elapsed * self._refill_per_second)
            self._updated_at = now
            if self._tokens < tokens:
                raise RateLimitError("provider rate limit exceeded", details={"scope": "provider"})
            self._tokens -= tokens
