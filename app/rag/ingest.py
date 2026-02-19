import argparse
import hashlib
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import pandas as pd
from langchain_core.documents import Document

from app.core.config import get_settings
from app.services.embedding_provider import build_embeddings, resolve_embedding_dimension


REQUIRED_QA_COLUMNS = {"question", "answer", "category", "priority", "last_updated"}
REQUIRED_QA_PARAPHRASE_COLUMNS = REQUIRED_QA_COLUMNS | {
    "seed_question",
    "seed_question_hash",
    "paraphrase_rank",
    "is_paraphrase",
}


def _sha1(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()


def _build_doc_id(metadata: dict, chunk_text: str, chunk_index: int) -> str:
    raw = (
        f"{metadata.get('doc_type', '')}|{metadata.get('source_file', '')}|"
        f"{metadata.get('section_path', '')}|{metadata.get('seed_question_hash', '')}|"
        f"{metadata.get('paraphrase_rank', '')}|{chunk_index}|{chunk_text}"
    )
    return _sha1(raw)


def _to_bool(value: object) -> bool:
    normalized = str(value).strip().lower()
    return normalized in {"1", "true", "yes", "y"}


def _clean_text(value: object) -> str:
    if value is None:
        return ""
    if pd.isna(value):
        return ""
    normalized = str(value).strip()
    if normalized.lower() == "nan":
        return ""
    return normalized


def parse_markdown_sections(text: str) -> list[tuple[str, str]]:
    sections: list[tuple[str, list[str]]] = []
    header_stack: list[str] = []
    current_lines: list[str] = []

    def flush_current() -> None:
        if not current_lines:
            return
        section_path = " > ".join(header_stack) if header_stack else "root"
        sections.append((section_path, current_lines.copy()))
        current_lines.clear()

    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        stripped = line.lstrip()
        if stripped.startswith("#"):
            flush_current()
            level = len(stripped) - len(stripped.lstrip("#"))
            title = stripped[level:].strip()
            if not title:
                title = "untitled"
            while len(header_stack) >= level:
                header_stack.pop()
            header_stack.append(title)
            continue
        current_lines.append(line)

    flush_current()
    normalized: list[tuple[str, str]] = []
    for section_path, lines in sections:
        content = "\n".join(lines).strip()
        if content:
            normalized.append((section_path, content))
    return normalized


def _read_csv_with_required_columns(path: Path, required_columns: set[str]) -> pd.DataFrame:
    frame = pd.read_csv(path)
    missing = required_columns - set(frame.columns)
    if missing:
        missing_cols = ", ".join(sorted(missing))
        raise ValueError(f"{path.name} is missing required columns: {missing_cols}")
    return frame


def load_qa_csv(path: Path, version_tag: str) -> list[Document]:
    if not path.exists():
        return []
    frame = _read_csv_with_required_columns(path, REQUIRED_QA_COLUMNS)

    now_iso = datetime.now(tz=timezone.utc).isoformat()
    docs: list[Document] = []
    for _, row in frame.iterrows():
        question = _clean_text(row["question"])
        answer = _clean_text(row["answer"])
        category = _clean_text(row["category"])
        priority = _clean_text(row["priority"])
        last_updated = _clean_text(row["last_updated"]) or now_iso
        if not question or not answer:
            continue

        docs.append(
            Document(
                page_content=f"Q: {question}\nA: {answer}",
                metadata={
                    "doc_type": "faq",
                    "source_file": str(path),
                    "section_path": f"faq > {category or 'general'}",
                    "category": category,
                    "priority": priority,
                    "is_paraphrase": False,
                    "seed_question": question,
                    "seed_question_hash": _sha1(question),
                    "paraphrase_rank": 0,
                    "version_tag": version_tag,
                    "updated_at": last_updated,
                },
            )
        )
    return docs


def load_qa_paraphrases_csv(path: Path, version_tag: str) -> list[Document]:
    if not path.exists():
        return []
    frame = _read_csv_with_required_columns(path, REQUIRED_QA_PARAPHRASE_COLUMNS)

    now_iso = datetime.now(tz=timezone.utc).isoformat()
    docs: list[Document] = []
    for _, row in frame.iterrows():
        question = _clean_text(row["question"])
        answer = _clean_text(row["answer"])
        category = _clean_text(row["category"])
        priority = _clean_text(row["priority"])
        last_updated = _clean_text(row["last_updated"]) or now_iso
        if not question or not answer:
            continue

        seed_question = _clean_text(row["seed_question"]) or question
        seed_question_hash = _clean_text(row["seed_question_hash"]) or _sha1(seed_question)
        paraphrase_rank = int(row.get("paraphrase_rank", 0) or 0)
        is_paraphrase = _to_bool(row.get("is_paraphrase", True))

        docs.append(
            Document(
                page_content=f"Q: {question}\nA: {answer}",
                metadata={
                    "doc_type": "faq",
                    "source_file": str(path),
                    "section_path": f"faq > {category or 'general'}",
                    "category": category,
                    "priority": priority,
                    "is_paraphrase": is_paraphrase,
                    "seed_question": seed_question,
                    "seed_question_hash": seed_question_hash,
                    "paraphrase_rank": paraphrase_rank,
                    "version_tag": version_tag,
                    "updated_at": last_updated,
                },
            )
        )
    return docs


def load_markdown_docs(base_dir: Path, doc_type: str, version_tag: str) -> list[Document]:
    docs: list[Document] = []
    now_iso = datetime.now(tz=timezone.utc).isoformat()
    for path in sorted(base_dir.rglob("*.md")):
        raw = path.read_text(encoding="utf-8")
        for section_path, content in parse_markdown_sections(raw):
            docs.append(
                Document(
                    page_content=content,
                    metadata={
                        "doc_type": doc_type,
                        "source_file": str(path),
                        "section_path": section_path,
                        "version_tag": version_tag,
                        "updated_at": now_iso,
                    },
                )
            )
    return docs


def collect_gold_documents(data_root: Path, version_tag: str) -> list[Document]:
    faq_path = data_root / "faq" / "qa.csv"
    faq_paraphrase_path = data_root / "faq" / "qa_paraphrases.csv"
    policies_dir = data_root / "policies"
    products_dir = data_root / "products"

    docs: list[Document] = []
    docs.extend(load_qa_csv(faq_path, version_tag=version_tag))
    docs.extend(load_qa_paraphrases_csv(faq_paraphrase_path, version_tag=version_tag))
    docs.extend(load_markdown_docs(policies_dir, doc_type="policy", version_tag=version_tag))
    docs.extend(load_markdown_docs(products_dir, doc_type="product", version_tag=version_tag))
    return docs


def _with_retry(func, *, attempts: int = 3, initial_delay: float = 0.7):
    delay = initial_delay
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return func()
        except Exception as exc:  # pragma: no cover - network/runtime defensive guard
            last_error = exc
            if attempt >= attempts:
                break
            time.sleep(delay)
            delay *= 2
    assert last_error is not None
    raise last_error


def _looks_like_embedding_quota_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return (
        "insufficient_quota" in text
        or "exceeded your current quota" in text
        or "resource_exhausted" in text
        or "quota" in text
    )


def _build_index_handle(pc, settings):
    if settings.pinecone_index_host:
        return pc.Index(host=settings.pinecone_index_host)
    return pc.Index(settings.pinecone_index)


def _build_vector_store(*, settings, embeddings, dimension: int):
    from langchain_pinecone import PineconeVectorStore
    from pinecone import Pinecone, ServerlessSpec

    pc = Pinecone(api_key=settings.pinecone_api_key)
    if settings.pinecone_index_host:
        # When host is provided, never fall back to control-plane.
        index = _with_retry(lambda: _build_index_handle(pc, settings), attempts=8)
        _with_retry(index.describe_index_stats, attempts=8, initial_delay=0.8)
        return PineconeVectorStore(index=index, embedding=embeddings)

    index = _with_retry(lambda: _build_index_handle(pc, settings), attempts=4)
    try:
        _with_retry(index.describe_index_stats, attempts=3)
        return PineconeVectorStore(index=index, embedding=embeddings)
    except Exception:
        pass

    def _ensure_index_with_control_plane() -> None:
        if pc.has_index(settings.pinecone_index):
            return
        pc.create_index(
            name=settings.pinecone_index,
            dimension=dimension,
            metric="cosine",
            spec=ServerlessSpec(cloud=settings.pinecone_cloud, region=settings.pinecone_region),
        )

    _with_retry(_ensure_index_with_control_plane, attempts=3)
    index = _with_retry(lambda: _build_index_handle(pc, settings), attempts=4)
    _with_retry(index.describe_index_stats, attempts=3)
    return PineconeVectorStore(index=index, embedding=embeddings)


def _chunk_documents(documents: Iterable[Document]) -> list[Document]:
    try:
        from langchain_text_splitters import RecursiveCharacterTextSplitter
    except ImportError:
        from langchain.text_splitter import RecursiveCharacterTextSplitter

    splitter = RecursiveCharacterTextSplitter(chunk_size=900, chunk_overlap=150)
    return splitter.split_documents(list(documents))


def ingest_gold_data(data_root: Path, version_tag: str) -> int:
    settings = get_settings()
    if not settings.pinecone_api_key:
        raise ValueError("PINECONE_API_KEY is required for ingestion.")

    documents = collect_gold_documents(data_root=data_root, version_tag=version_tag)
    if not documents:
        return 0

    chunks = _chunk_documents(documents)
    ids = [_build_doc_id(chunk.metadata, chunk.page_content, i) for i, chunk in enumerate(chunks)]

    embeddings = build_embeddings(settings)
    dimension = resolve_embedding_dimension(settings, embeddings)
    vector_store = _build_vector_store(settings=settings, embeddings=embeddings, dimension=dimension)

    try:
        _with_retry(
            lambda: vector_store.add_documents(documents=chunks, ids=ids),
            attempts=3,
        )
    except Exception as exc:
        if _looks_like_embedding_quota_error(exc):
            raise RuntimeError(
                "Embedding quota exceeded during vector generation. "
                "Check provider billing/credits and rerun ingest."
            ) from exc
        raise
    return len(chunks)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Ingest curated gold data into Pinecone.")
    parser.add_argument(
        "--data-root",
        default="data/gold",
        help="Root directory containing faq/, policies/, and products/ directories.",
    )
    parser.add_argument(
        "--version-tag",
        default=datetime.now(tz=timezone.utc).strftime("%Y%m%d"),
        help="Version tag stored in metadata for traceability.",
    )
    return parser


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()
    data_root = Path(args.data_root)
    if not data_root.exists():
        raise FileNotFoundError(f"Data root not found: {data_root}")

    upserted = ingest_gold_data(data_root=data_root, version_tag=args.version_tag)
    print(f"Ingest complete. upserted_chunks={upserted}")


if __name__ == "__main__":
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    main()
