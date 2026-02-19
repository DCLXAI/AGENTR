from collections.abc import Callable
from typing import Any, Literal, TypeVar

from app.core.config import Settings


LLMProvider = Literal["gemini", "openai"]
LLMPurpose = Literal["classifier", "generation", "generation_upgrade"]
T = TypeVar("T")


def _select_model_name(settings: Settings, provider: LLMProvider, purpose: LLMPurpose) -> str:
    if provider == "gemini":
        if purpose == "classifier":
            return settings.gemini_model_classifier
        if purpose == "generation_upgrade":
            return settings.gemini_model_generation_upgrade
        return settings.gemini_model_generation

    if purpose == "classifier":
        return settings.openai_model_classifier
    if purpose == "generation_upgrade":
        return settings.openai_model_generation_upgrade
    return settings.openai_model_generation


def available_provider_order(settings: Settings) -> list[LLMProvider]:
    has_gemini = bool(settings.gemini_api_key.strip())
    has_openai = bool(settings.openai_api_key.strip())
    if not has_gemini and not has_openai:
        raise ValueError("At least one LLM API key is required (GEMINI_API_KEY or OPENAI_API_KEY).")

    primary = settings.llm_primary_provider
    order: list[LLMProvider] = []
    if primary == "gemini":
        if has_gemini:
            order.append("gemini")
        if has_openai:
            order.append("openai")
    else:
        if has_openai:
            order.append("openai")
        if has_gemini:
            order.append("gemini")
    return order


def _build_chat_model(settings: Settings, provider: LLMProvider, purpose: LLMPurpose):
    model_name = _select_model_name(settings, provider, purpose)
    if provider == "gemini":
        from langchain_google_genai import ChatGoogleGenerativeAI

        return ChatGoogleGenerativeAI(
            model=model_name,
            google_api_key=settings.gemini_api_key,
            temperature=0,
        )

    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        model=model_name,
        temperature=0,
        api_key=settings.openai_api_key,
    )


def invoke_with_fallback(
    *,
    settings: Settings,
    purpose: LLMPurpose,
    invoker: Callable[[Any, LLMProvider], T],
) -> T:
    errors: list[str] = []
    for provider in available_provider_order(settings):
        try:
            llm = _build_chat_model(settings, provider=provider, purpose=purpose)
            return invoker(llm, provider)
        except Exception as exc:  # pragma: no cover - runtime/provider fallback
            errors.append(f"{provider}:{exc.__class__.__name__}")

    raise RuntimeError(f"All LLM providers failed for purpose='{purpose}'. errors={errors}")
