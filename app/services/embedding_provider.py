from typing import Any

from app.core.config import Settings


def build_embeddings(settings: Settings):
    provider = settings.embedding_provider
    if provider == "gemini":
        if not settings.gemini_api_key:
            raise ValueError("GEMINI_API_KEY is required for Gemini embeddings.")
        from langchain_google_genai import GoogleGenerativeAIEmbeddings

        kwargs: dict[str, Any] = {
            "model": settings.embedding_model_gemini,
            "google_api_key": settings.gemini_api_key,
        }
        if settings.embedding_output_dimensionality > 0:
            kwargs["output_dimensionality"] = settings.embedding_output_dimensionality
        return GoogleGenerativeAIEmbeddings(**kwargs)

    if not settings.openai_api_key:
        raise ValueError("OPENAI_API_KEY is required for OpenAI embeddings.")
    from langchain_openai import OpenAIEmbeddings

    return OpenAIEmbeddings(model=settings.embedding_model, api_key=settings.openai_api_key)


def resolve_embedding_dimension(settings: Settings, embeddings) -> int:
    if settings.embedding_provider == "gemini" and settings.embedding_output_dimensionality > 0:
        return int(settings.embedding_output_dimensionality)

    try:
        sample = embeddings.embed_query("dimension_probe")
        return len(sample)
    except Exception:
        if settings.embedding_provider == "openai" and settings.embedding_model == "text-embedding-3-small":
            return 1536
        raise

