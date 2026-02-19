from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.rag.ingest import ingest_gold_data
from app.repositories.supabase_repo import get_supabase_repo


router = APIRouter(prefix="/v1/rag", tags=["rag"])


class RAGIngestRequest(BaseModel):
    source_paths: list[str] = Field(default_factory=lambda: ["data/gold"])
    doc_type: str = Field(default="gold")
    version_tag: str


class RAGIngestResponse(BaseModel):
    status: str
    upserted_chunks: int


@router.post("/ingest", response_model=RAGIngestResponse)
def ingest(payload: RAGIngestRequest) -> RAGIngestResponse:
    if not payload.source_paths:
        raise HTTPException(status_code=400, detail="source_paths must not be empty.")

    # Gold Data only MVP: first source root is used.
    source_root = Path(payload.source_paths[0])
    if not source_root.exists():
        raise HTTPException(status_code=400, detail=f"source path not found: {source_root}")

    try:
        upserted = ingest_gold_data(data_root=source_root, version_tag=payload.version_tag)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail="ingest failed") from exc
    repo = get_supabase_repo()
    repo.log_rag_ingest_job(
        tenant_id="default",
        version_tag=payload.version_tag,
        source_paths=payload.source_paths,
        upserted_chunks=upserted,
        status="done",
        why_fallback=None,
    )

    return RAGIngestResponse(status="ok", upserted_chunks=upserted)
