import re
from functools import lru_cache
from typing import Literal

from pydantic import BaseModel, Field
from langchain_core.prompts import ChatPromptTemplate

from app.core.config import Settings, get_settings
from app.services.llm_provider import invoke_with_fallback


IntentType = Literal["tracking", "policy", "fallback"]


class IntentEntities(BaseModel):
    tracking_number: str | None = None
    courier_code: str | None = None


class IntentClassification(BaseModel):
    intent: IntentType = "fallback"
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    entities: IntentEntities = Field(default_factory=IntentEntities)


TRACKING_NUMBER_PATTERN = re.compile(r"\b\d{10,14}\b")
TRACKING_HINT_WORDS = ("배송", "운송장", "택배", "조회", "도착")
POLICY_HINT_WORDS = ("반품", "환불", "교환", "정책", "배송비", "적립금", "규정", "멤버십")


def _normalize_for_match(text: str) -> str:
    return text.strip().lower().replace(" ", "")


def _heuristic_confidence(question: str, intent: IntentType) -> float:
    q = _normalize_for_match(question)
    if intent == "tracking":
        if TRACKING_NUMBER_PATTERN.search(question):
            return 0.96
        if any(word in q for word in TRACKING_HINT_WORDS):
            return 0.88
        return 0.7

    if intent == "policy":
        if any(word in q for word in POLICY_HINT_WORDS):
            return 0.86
        return 0.72

    return 0.55


class IntentClassifier:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "너는 한국어 이커머스 CS 분류기다. intent는 tracking, policy, fallback 중 하나만 선택한다. "
                    "tracking: 배송위치, 운송장, 택배조회. policy: 환불/반품/교환/배송비/적립금/운영규정. "
                    "fallback: 그 외. confidence는 0~1로 보수적으로 준다.",
                ),
                (
                    "human",
                    "질문: {question}\n"
                    "JSON으로만 응답한다. entities.tracking_number와 entities.courier_code를 추출한다.",
                ),
            ]
        )

    def classify(self, question: str) -> IntentClassification:
        def _invoke(llm, _provider):
            chain = self.prompt | llm.with_structured_output(IntentClassification)
            response = chain.invoke({"question": question})
            return IntentClassification.model_validate(response)

        result = invoke_with_fallback(
            settings=self.settings,
            purpose="classifier",
            invoker=_invoke,
        )

        if result.intent == "tracking" and not result.entities.tracking_number:
            match = TRACKING_NUMBER_PATTERN.search(question)
            if match:
                result.entities.tracking_number = match.group(0)
        if result.confidence <= 0:
            result.confidence = _heuristic_confidence(question, result.intent)

        return result


@lru_cache(maxsize=1)
def get_intent_classifier() -> IntentClassifier:
    return IntentClassifier(get_settings())
