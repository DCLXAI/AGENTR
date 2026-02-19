from app.rag.faq_paraphraser import (
    deduplicate_paraphrases,
    parse_paraphrases_from_json,
    preserves_numeric_constraints,
)


def test_parse_paraphrases_from_json() -> None:
    raw = '{"paraphrases":["A","B","C","D","E"]}'
    parsed = parse_paraphrases_from_json(raw)
    assert parsed == ["A", "B", "C", "D", "E"]


def test_preserves_numeric_constraints() -> None:
    seed = "반품은 수령 후 7일 이내 가능하나요?"
    assert preserves_numeric_constraints(seed, "수령 후 7일 안에 반품 접수 가능한가요?")
    assert not preserves_numeric_constraints(seed, "수령 후 14일 안에 반품 접수 가능한가요?")


def test_deduplicate_paraphrases_filters_duplicates() -> None:
    seed = "무료 배송 기준은 무엇인가요?"
    candidates = [
        "무료 배송 기준은 무엇인가요?",
        "무료배송은 얼마부터인가요?",
        "무료배송은 얼마부터인가요?",
        "배송비 면제 기준 알려주세요.",
        "5만원 이상이면 무료 배송인가요?",
        "결제금액 50,000원 이상 무료배송 맞나요?",
        "무료 배송 적용 조건이 어떻게 되나요?",
    ]
    deduped = deduplicate_paraphrases(seed, candidates, count=5)
    assert len(deduped) == 5
    assert len(set(deduped)) == 5

