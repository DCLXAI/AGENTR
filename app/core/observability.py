import logging
import uuid
from typing import Callable

from fastapi import FastAPI, Request, Response

from app.core.config import get_settings


logger = logging.getLogger("shop_ai")


def _configure_sentry() -> None:
    settings = get_settings()
    if not settings.sentry_dsn:
        return
    try:
        import sentry_sdk

        sentry_sdk.init(
            dsn=settings.sentry_dsn,
            environment=settings.app_env,
            traces_sample_rate=0.1,
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Failed to initialize Sentry: %s", exc)


def configure_observability(app: FastAPI) -> None:
    _configure_sentry()

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next: Callable) -> Response:
        request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response

