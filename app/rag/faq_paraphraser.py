import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any

import pandas as pd
from langchain_core.prompts import ChatPromptTemplate

from app.core.config import get_settings
from app.services.llm_provider import invoke_with_fallback


SYSTEM_PROMPT = """당신은 이커머스 전문 CS 상담원입니다.
주어진 원본 질문의 의미와 정책 조건(기간, 금액, 예외)을 절대 훼손하지 말고
한국어 유사 질문을 생성하세요.

출력 조건:
- JSON 객체 형식만 출력
- 키는 반드시 paraphrases
- paraphrases는 문자열 5개의 배열
- 원문과 동일한 문장은 제외
- 숫자(예: 7일, 50,000원, 6,000원, 12개월)는 의미를 유지
"""

REQUIRED_COLUMNS = {"question", "answer", "category", "priority", "last_updated"}
CACHE_COLUMNS = [
    "question",
    "answer",
    "category",
    "priority",
    "last_updated",
    "seed_question",
    "seed_question_hash",
    "paraphrase_rank",
    "is_paraphrase",
    "generation_model",
]


def seed_hash(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def extract_numbers(text: str) -> list[str]:
    return re.findall(r"\d+(?:[.,]\d+)?", text)


def preserves_numeric_constraints(seed_question: str, paraphrase: str) -> bool:
    seed_numbers = extract_numbers(seed_question)
    if not seed_numbers:
        return True
    return all(number in paraphrase for number in seed_numbers)


def _extract_json_payload(raw_content: str) -> str:
    text = (raw_content or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text)
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        return text[start : end + 1]
    return text


def parse_paraphrases_from_json(raw_content: str) -> list[str]:
    parsed = json.loads(_extract_json_payload(raw_content))
    candidates = parsed.get("paraphrases", [])
    if not isinstance(candidates, list):
        return []
    return [str(item).strip() for item in candidates if str(item).strip()]


def deduplicate_paraphrases(seed_question: str, candidates: list[str], count: int) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    seed_norm = normalize(seed_question)
    for candidate in candidates:
        normalized = normalize(candidate)
        if not normalized or normalized == seed_norm:
            continue
        if normalized in seen:
            continue
        if not preserves_numeric_constraints(seed_question, candidate):
            continue
        seen.add(normalized)
        output.append(candidate)
        if len(output) == count:
            break
    return output


def _generate_raw_paraphrases(
    *,
    seed_question: str,
    count: int,
) -> str:
    settings = get_settings()
    prompt = ChatPromptTemplate.from_messages(
        [
            ("system", SYSTEM_PROMPT),
            (
                "human",
                "원본 질문: {seed_question}\n"
                "반드시 paraphrases 배열 길이를 {count}로 맞춰 주세요.\n"
                "JSON 객체로만 응답하세요.",
            ),
        ]
    )

    def _invoke(llm, _provider):
        result = (prompt | llm).invoke({"seed_question": seed_question, "count": count})
        return str(result.content or "")

    return invoke_with_fallback(
        settings=settings,
        purpose="generation_upgrade",
        invoker=_invoke,
    )


def generate_paraphrases(
    *,
    seed_question: str,
    count: int = 5,
) -> list[str]:
    attempts = 0
    accepted: list[str] = []
    while attempts < 2:
        attempts += 1
        content = _generate_raw_paraphrases(seed_question=seed_question, count=count)
        candidates = parse_paraphrases_from_json(content)
        accepted = deduplicate_paraphrases(seed_question, candidates, count=count)
        if len(accepted) == count:
            return accepted
    raise RuntimeError(f"Failed to generate {count} paraphrases for question: {seed_question}")


def _validate_input_frame(frame: pd.DataFrame) -> None:
    missing = REQUIRED_COLUMNS - set(frame.columns)
    if missing:
        raise ValueError(f"qa.csv missing required columns: {', '.join(sorted(missing))}")


def _load_cache(output_path: Path) -> dict[str, list[dict[str, Any]]]:
    if not output_path.exists():
        return {}
    frame = pd.read_csv(output_path)
    missing = set(CACHE_COLUMNS) - set(frame.columns)
    if missing:
        return {}
    grouped: dict[str, list[dict[str, Any]]] = {}
    for _, row in frame.iterrows():
        seed = str(row.get("seed_question_hash", "")).strip()
        if not seed:
            continue
        grouped.setdefault(seed, []).append(row.to_dict())
    return grouped


def build_paraphrase_cache(
    *,
    input_path: Path,
    output_path: Path,
    per_question: int = 5,
    refresh: bool = False,
) -> int:
    settings = get_settings()
    if not settings.gemini_api_key and not settings.openai_api_key:
        raise ValueError("At least one LLM key is required (GEMINI_API_KEY or OPENAI_API_KEY).")

    frame = pd.read_csv(input_path)
    _validate_input_frame(frame)
    existing = _load_cache(output_path) if not refresh else {}
    rows: list[dict[str, Any]] = []

    for _, row in frame.iterrows():
        question = str(row["question"]).strip()
        if not question:
            continue
        question_hash = seed_hash(question)
        cached_rows = existing.get(question_hash, [])
        if not refresh and len(cached_rows) >= per_question:
            sorted_cached = sorted(cached_rows, key=lambda item: int(item.get("paraphrase_rank", 999)))
            rows.extend(sorted_cached[:per_question])
            continue

        generated = generate_paraphrases(
            seed_question=question,
            count=per_question,
        )
        for rank, paraphrase in enumerate(generated, start=1):
            rows.append(
                {
                    "question": paraphrase,
                    "answer": str(row["answer"]).strip(),
                    "category": str(row["category"]).strip(),
                    "priority": str(row["priority"]).strip(),
                    "last_updated": str(row["last_updated"]).strip(),
                    "seed_question": question,
                    "seed_question_hash": question_hash,
                    "paraphrase_rank": rank,
                    "is_paraphrase": True,
                    "generation_model": f"{settings.llm_primary_provider}-paraphraser",
                }
            )

    out = pd.DataFrame(rows, columns=CACHE_COLUMNS)
    out.to_csv(output_path, index=False)
    return len(out)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate cached paraphrases for FAQ questions.")
    parser.add_argument("--input", default="data/gold/faq/qa.csv", help="Seed QA CSV path.")
    parser.add_argument("--output", default="data/gold/faq/qa_paraphrases.csv", help="Paraphrase cache CSV path.")
    parser.add_argument("--per-question", type=int, default=5, help="Number of paraphrases per seed question.")
    parser.add_argument("--refresh", action="store_true", help="Regenerate cache even when output already exists.")
    return parser


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)
    if not input_path.exists():
        raise FileNotFoundError(f"input csv not found: {input_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    generated_count = build_paraphrase_cache(
        input_path=input_path,
        output_path=output_path,
        per_question=args.per_question,
        refresh=args.refresh,
    )
    print(f"Paraphrase cache ready. rows={generated_count} path={output_path}")


if __name__ == "__main__":
    main()
