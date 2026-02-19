from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes.chat import router as chat_router
from app.api.routes.infra import router as infra_router
from app.api.routes.infra_test import router as infra_test_router
from app.api.routes.rag import router as rag_router
from app.api.routes.tools import router as tools_router
from app.core.config import get_settings
from app.core.observability import configure_observability


def create_app() -> FastAPI:
    settings = get_settings()
    settings.validate_runtime()

    app = FastAPI(title="Shop AI API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.get_cors_allowed_origins(),
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )
    configure_observability(app)
    app.include_router(chat_router)
    app.include_router(infra_router)
    app.include_router(infra_test_router)
    app.include_router(rag_router)
    app.include_router(tools_router)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
