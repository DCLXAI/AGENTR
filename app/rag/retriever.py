from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

from langchain_core.documents import Document
from langchain_core.prompts import ChatPromptTemplate

from app.core.config import Settings, get_settings
from app.services.embedding_provider import build_embeddings
from app.services.llm_provider import invoke_with_fallback


IntentType = Literal["tracking", "policy", "fallback"]


@dataclass
class ScoredDocument:
    document: Document
    score: float


@dataclass
class RAGAnswer:
    answer: str
    sources: list[dict]
    needs_human: bool


def _title_from_path(path: str) -> str:
    if not path:
        return "unknown-source"
    normalized = path.replace("\\", "/")
    return normalized.split("/")[-1]


def _format_source(doc: Document, score: float) -> dict:
    snippet = doc.page_content.replace("\n", " ").strip()
    if len(snippet) > 180:
        snippet = snippet[:177].rstrip() + "..."
    source_file = str(doc.metadata.get("source_file", ""))
    section_path = str(doc.metadata.get("section_path", ""))
    source_id = f"{source_file}::{section_path}"
    title = f"{_title_from_path(source_file)} / {section_path}"
    return {
        "source_id": source_id,
        "title": title,
        "snippet": snippet,
        "score": round(score, 4),
    }


class RAGService:
    def __init__(self, settings: Settings):
        from langchain_pinecone import PineconeVectorStore
        from pinecone import Pinecone

        self.settings = settings
        if not settings.pinecone_api_key:
            raise ValueError("PINECONE_API_KEY is required.")
        self._pc = Pinecone(api_key=settings.pinecone_api_key)
        self._embeddings = build_embeddings(settings)
        if settings.pinecone_index_host:
            index = self._pc.Index(host=settings.pinecone_index_host)
        else:
            index = self._pc.Index(settings.pinecone_index)
        self._vector_store = PineconeVectorStore(
            index=index,
            embedding=self._embeddings,
        )

    def retrieve(self, question: str, k: int | None = None) -> list[ScoredDocument]:
        top_k = k or self.settings.retriever_k
        matches = self._vector_store.similarity_search_with_relevance_scores(question, k=top_k)
        return [ScoredDocument(document=doc, score=score) for doc, score in matches]

    def _generate(self, question: str, context_docs: list[ScoredDocument], strong_model: bool = False) -> str:
        context = "\n\n".join(
            [
                f"[source={idx + 1} score={doc.score:.3f}] {doc.document.page_content}"
                for idx, doc in enumerate(context_docs)
            ]
        )
        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "너는 한국어 쇼핑몰 CS AI다. 반드시 제공된 context만 근거로 답변한다. "
                    "근거가 불충분하면 반드시 '확인 불가'라고 답하고 필요한 추가 정보를 요청한다. "
                    "불필요한 추측을 하지 말고 짧고 정확하게 답한다.",
                ),
                (
                    "human",
                    "질문: {question}\n\n"
                    "context:\n{context}\n\n"
                    "답변 형식: 핵심 답변 2~4문장 + 마지막 문장으로 "
                    f"'{self.settings.default_answer_closing}'",
                ),
            ]
        )
        purpose = "generation_upgrade" if strong_model else "generation"

        def _invoke(llm, _provider):
            chain = prompt | llm
            response = chain.invoke({"question": question, "context": context})
            content = (response.content or "").strip()
            if not content:
                raise RuntimeError("empty-generation")
            return content

        try:
            content = invoke_with_fallback(
                settings=self.settings,
                purpose=purpose,
                invoker=_invoke,
            )
        except Exception:
            return f"확인 불가입니다. 질문에 필요한 근거가 부족합니다. {self.settings.default_answer_closing}"
        return self._append_closing(content)

    def _append_closing(self, answer: str) -> str:
        answer = answer.strip()
        if answer.endswith(self.settings.default_answer_closing):
            return answer
        return f"{answer} {self.settings.default_answer_closing}"

    def answer(self, question: str, intent: IntentType, upgrade_generation: bool = False) -> RAGAnswer:
        scored_docs = self.retrieve(question=question)
        filtered = [item for item in scored_docs if item.score >= self.settings.source_score_threshold]
        sources = [_format_source(item.document, item.score) for item in filtered]

        if intent == "policy" and not filtered:
            return RAGAnswer(
                answer=(
                    "확인 불가입니다. 정책 근거가 검색되지 않았습니다. "
                    "반품/환불 정책 문서 최신 버전을 확인해 주세요. "
                    f"{self.settings.default_answer_closing}"
                ),
                sources=[],
                needs_human=True,
            )

        if not filtered:
            return RAGAnswer(
                answer=(
                    "확인 불가입니다. 제공된 문서에서 근거를 찾지 못했습니다. "
                    "주문번호, 상품명, 운송장번호 등 추가 정보를 알려주세요. "
                    f"{self.settings.default_answer_closing}"
                ),
                sources=[],
                needs_human=True,
            )

        generated = self._generate(question=question, context_docs=filtered, strong_model=upgrade_generation)
        return RAGAnswer(answer=generated, sources=sources, needs_human=False)


@lru_cache(maxsize=1)
def get_rag_service() -> RAGService:
    return RAGService(get_settings())
