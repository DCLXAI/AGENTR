from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse

from app.api.routes.chat import router as chat_router
from app.api.routes.infra import router as infra_router
from app.api.routes.infra_test import router as infra_test_router
from app.api.routes.leads import router as leads_router
from app.api.routes.rag import router as rag_router
from app.api.routes.tools import (
    router as tools_router,
    start_naver_autoreply_worker_if_enabled,
    stop_naver_autoreply_worker,
)
from app.core.config import get_settings
from app.core.observability import configure_observability


def create_app() -> FastAPI:
    settings = get_settings()
    settings.validate_runtime()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        start_naver_autoreply_worker_if_enabled()
        try:
            yield
        finally:
            stop_naver_autoreply_worker()

    app = FastAPI(title="Shop AI API", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.get_cors_allowed_origins(),
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )
    configure_observability(app)
    static_dir = Path(__file__).resolve().parent / "static"
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")
    app.include_router(chat_router)
    app.include_router(infra_router)
    app.include_router(infra_test_router)
    app.include_router(leads_router)
    app.include_router(rag_router)
    app.include_router(tools_router)

    @app.get("/")
    def root() -> RedirectResponse:
        return RedirectResponse(url="/static/homepage.html", status_code=307)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
