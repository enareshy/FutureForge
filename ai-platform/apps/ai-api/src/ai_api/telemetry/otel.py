from __future__ import annotations

from fastapi import FastAPI

from ai_api.config.settings import Settings
from ai_api.telemetry.logging import get_logger


def configure_telemetry(app: FastAPI, settings: Settings) -> None:
    logger = get_logger("telemetry")
    if not settings.otel_enabled:
        logger.info("telemetry.disabled")
        return

    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError:
        logger.warning("telemetry.dependencies_missing")
        return

    resource = Resource.create(
        {
            "service.name": settings.otel_service_name,
            "deployment.environment": settings.ai_env,
        }
    )
    provider = TracerProvider(resource=resource)
    exporter = OTLPSpanExporter(
        endpoint=settings.otel_exporter_otlp_endpoint, insecure=True
    )
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    FastAPIInstrumentor.instrument_app(
        app, excluded_urls="/healthz,/api/v1/ai/health"
    )
    logger.info("telemetry.enabled", endpoint=settings.otel_exporter_otlp_endpoint)
