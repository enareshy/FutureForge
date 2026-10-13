from __future__ import annotations

from typing import Any


class DomainError(Exception):
    code: str = "internal_error"
    http_status: int = 500

    def __init__(self, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details: dict[str, Any] = details or {}


class ValidationError(DomainError):
    code = "validation_error"
    http_status = 422


class AuthenticationError(DomainError):
    code = "unauthorized"
    http_status = 401


class AuthorizationError(DomainError):
    code = "forbidden"
    http_status = 403


class NotFoundError(DomainError):
    code = "not_found"
    http_status = 404


class ConflictError(DomainError):
    code = "conflict"
    http_status = 409


class RateLimitError(DomainError):
    code = "rate_limited"
    http_status = 429


class ConfigurationError(DomainError):
    code = "configuration_error"
    http_status = 500


class ProviderError(DomainError):
    code = "provider_error"
    http_status = 502


class ServiceUnavailableError(DomainError):
    code = "service_unavailable"
    http_status = 503


class DatabaseUnavailableError(ServiceUnavailableError):
    code = "database_unavailable"


class FeatureUnavailableError(ServiceUnavailableError):
    code = "feature_unavailable"


class ApprovalRequiredError(DomainError):
    code = "approval_required"
    http_status = 409
