from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from ai_api import __version__
from ai_api.api.deps import get_database
from ai_api.api.errors import register_exception_handlers
from ai_api.api.v1.router import api_router
from ai_api.config.settings import get_settings
from ai_api.telemetry import (
    RequestContextMiddleware,
    configure_logging,
    configure_telemetry,
    get_logger,
)

API_PREFIX = "/api/v1/ai"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings = get_settings()
    if settings.ai_repository == "postgres":
        try:
            await get_database().connect()
        except Exception as exc:  # noqa: BLE001 - app still starts; endpoints fail closed
            get_logger("startup").warning("db.unavailable_at_startup", error=str(exc))
    yield
    if settings.ai_repository == "postgres":
        await get_database().close()


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.ai_api_log_level, json_logs=settings.is_production)

    app = FastAPI(
        title="Enterprise AI Platform API",
        version=__version__,
        docs_url=f"{API_PREFIX}/docs",
        redoc_url=None,
        openapi_url=f"{API_PREFIX}/openapi.json",
        lifespan=lifespan,
    )
    app.state.settings = settings

    app.add_middleware(RequestContextMiddleware)
    register_exception_handlers(app)
    configure_telemetry(app, settings)

    @app.get("/healthz", tags=["health"])
    def liveness() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(api_router, prefix=API_PREFIX)
    get_logger("startup").info(
        "app.configured", environment=settings.ai_env, version=__version__
    )
    return app


app = create_app()


def main() -> None:
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "ai_api.main:app",
        host=settings.ai_api_host,
        port=settings.ai_api_port,
        log_level=settings.ai_api_log_level,
    )


if __name__ == "__main__":
    main()
