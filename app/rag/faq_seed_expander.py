import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

import pandas as pd
from langchain_core.prompts import ChatPromptTemplate

from app.core.config import get_settings
from app.services.llm_provider import invoke_with_fallback


REQUIRED_COLUMNS = ["question", "answer", "category", "priority", "last_updated"]
REQUIRED_CATEGORIES = ["shipping", "policy", "order", "membership", "product"]
DEFAULT_LAST_UPDATED = "2026-02-19"

SYSTEM_PROMPT = """당신은 한국 이커머스 CS FAQ 데이터셋 작성자입니다.
주어진 seed FAQ와 같은 의미/정책 범위에서 고객이 실제로 물어볼 새로운 질문만 생성하세요.

규칙:
1) 질문은 반드시 한국어.
2) 원본 질문과 중복 금지.
3) 숫자/기간/금액 조건(예: 7일, 50,000원, 6,000원)은 그대로 유지.
4) 답변은 seed의 답변을 그대로 사용하므로, 질문은 seed와 의미 충돌이 없어야 함.
5) JSON만 출력: {"questions":["...","..."]}
"""


def normalize_question(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def extract_numbers(text: str) -> list[str]:
    return re.findall(r"\d+(?:[.,]\d+)?", text)


def numbers_preserved(seed_text: str, candidate: str) -> bool:
    seed_numbers = extract_numbers(seed_text)
    if not seed_numbers:
        return True
    return all(number in candidate for number in seed_numbers)


def parse_questions(raw: str) -> list[str]:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text)
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        text = text[start : end + 1]
    payload = json.loads(text)
    questions = payload.get("questions", [])
    if not isinstance(questions, list):
        return []
    return [str(item).strip() for item in questions if str(item).strip()]


def fallback_questions(seed_question: str, count: int) -> list[str]:
    base = seed_question.rstrip("?").strip()
    templates = [
        f"{base} 알려주세요?",
        f"{base} 확인 부탁드려요.",
        f"{base} 맞나요?",
        f"{base} 기준이 궁금해요.",
        f"{base} 어떻게 되나요?",
        f"{base} 안내 받을 수 있을까요?",
    ]
    return templates[:count]


def synthetic_question(seed_question: str, serial: int) -> str:
    base = seed_question.rstrip("?").strip()
    templates = [
        f"{base} 기준을 다시 확인 부탁드려요.",
        f"{base} 관련해서 정확한 안내 부탁드립니다.",
        f"{base} 고객센터 기준으로 어떻게 되나요?",
        f"{base} 적용 조건을 한 번 더 설명해 주세요.",
        f"{base} 최종 정책 기준이 궁금합니다.",
    ]
    if serial <= len(templates):
        return templates[serial - 1]
    return f"{base} 관련 기준 안내 부탁드립니다 ({serial})."


def generate_questions_for_seed(seed_question: str, seed_answer: str, count: int = 6) -> list[str]:
    settings = get_settings()
    prompt = ChatPromptTemplate.from_messages(
        [
            ("system", SYSTEM_PROMPT),
            (
                "human",
                "seed question: {seed_question}\n"
                "seed answer: {seed_answer}\n"
                "필요 개수: {count}\n"
                "JSON으로만 응답하세요.",
            ),
        ]
    )

    def _invoke(llm, _provider):
        result = (prompt | llm).invoke(
            {"seed_question": seed_question, "seed_answer": seed_answer, "count": count}
        )
        return str(result.content or "")

    try:
        raw = invoke_with_fallback(settings=settings, purpose="generation_upgrade", invoker=_invoke)
        parsed = parse_questions(raw)
    except Exception:
        parsed = fallback_questions(seed_question, count)

    normalized_seed = normalize_question(seed_question)
    deduped: list[str] = []
    seen: set[str] = set()
    for question in parsed:
        normalized = normalize_question(question)
        if not normalized or normalized == normalized_seed or normalized in seen:
            continue
        if not numbers_preserved(seed_question, question):
            continue
        seen.add(normalized)
        deduped.append(question)
    if not deduped:
        deduped = fallback_questions(seed_question, count)
    return deduped


def build_category_plan(existing: pd.DataFrame, target_total: int) -> list[str]:
    needed = max(0, target_total - len(existing))
    counts = Counter(str(v).strip() for v in existing["category"].tolist())
    for category in REQUIRED_CATEGORIES:
        counts.setdefault(category, 0)

    plan: list[str] = []
    for _ in range(needed):
        category = min(REQUIRED_CATEGORIES, key=lambda item: (counts[item], item))
        plan.append(category)
        counts[category] += 1
    return plan


def expand_faq(
    *,
    input_csv: Path,
    output_csv: Path,
    target_total: int = 50,
    generated_per_seed: int = 6,
) -> pd.DataFrame:
    if not input_csv.exists():
        raise FileNotFoundError(f"input not found: {input_csv}")

    frame = pd.read_csv(input_csv)
    missing = set(REQUIRED_COLUMNS) - set(frame.columns)
    if missing:
        raise ValueError(f"qa.csv missing required columns: {', '.join(sorted(missing))}")

    for category in REQUIRED_CATEGORIES:
        if category not in set(frame["category"].astype(str).str.strip()):
            raise ValueError(f"required category is missing in qa.csv: {category}")

    category_plan = build_category_plan(frame, target_total=target_total)
    if not category_plan:
        out = pd.DataFrame(columns=REQUIRED_COLUMNS + ["seed_question", "generation_model"])
        out.to_csv(output_csv, index=False)
        return out

    seeds_by_category: dict[str, list[dict]] = defaultdict(list)
    for _, row in frame.iterrows():
        category = str(row["category"]).strip()
        seeds_by_category[category].append(
            {
                "question": str(row["question"]).strip(),
                "answer": str(row["answer"]).strip(),
                "priority": str(row["priority"]).strip(),
                "last_updated": str(row["last_updated"]).strip() or DEFAULT_LAST_UPDATED,
            }
        )

    generated_bank: dict[tuple[str, str], list[str]] = {}
    for category, seeds in seeds_by_category.items():
        for seed in seeds:
            key = (category, seed["question"])
            generated_bank[key] = generate_questions_for_seed(
                seed_question=seed["question"],
                seed_answer=seed["answer"],
                count=generated_per_seed,
            )

    existing_questions = {normalize_question(str(v)) for v in frame["question"].tolist()}
    next_seed_index: dict[str, int] = defaultdict(int)
    next_generated_index: dict[tuple[str, str], int] = defaultdict(int)
    synthetic_serial: dict[tuple[str, str], int] = defaultdict(int)

    selected: list[dict] = []
    for category in category_plan:
        seeds = seeds_by_category[category]
        if not seeds:
            continue

        made = False
        for _ in range(len(seeds)):
            seed_idx = next_seed_index[category] % len(seeds)
            next_seed_index[category] += 1
            seed = seeds[seed_idx]
            key = (category, seed["question"])
            variants = generated_bank.get(key, [])
            if not variants:
                continue

            start_idx = next_generated_index[key]
            for offset in range(len(variants)):
                variant = variants[(start_idx + offset) % len(variants)]
                normalized = normalize_question(variant)
                if normalized in existing_questions:
                    continue
                selected.append(
                    {
                        "question": variant,
                        "answer": seed["answer"],
                        "category": category,
                        "priority": seed["priority"] or "medium",
                        "last_updated": seed["last_updated"] or DEFAULT_LAST_UPDATED,
                        "seed_question": seed["question"],
                        "generation_model": "gemini-seed-expander",
                    }
                )
                existing_questions.add(normalized)
                next_generated_index[key] = (start_idx + offset + 1) % len(variants)
                made = True
                break
            if made:
                break
        if not made:
            seed = seeds[(next_seed_index[category] - 1) % len(seeds)]
            key = (category, seed["question"])
            for _ in range(20):
                synthetic_serial[key] += 1
                variant = synthetic_question(seed["question"], synthetic_serial[key])
                normalized = normalize_question(variant)
                if normalized in existing_questions:
                    continue
                if not numbers_preserved(seed["question"], variant):
                    continue
                selected.append(
                    {
                        "question": variant,
                        "answer": seed["answer"],
                        "category": category,
                        "priority": seed["priority"] or "medium",
                        "last_updated": seed["last_updated"] or DEFAULT_LAST_UPDATED,
                        "seed_question": seed["question"],
                        "generation_model": "synthetic-fallback",
                    }
                )
                existing_questions.add(normalized)
                made = True
                break
            if not made:
                raise RuntimeError("Failed to satisfy target count with unique candidates.")

    out = pd.DataFrame(selected)
    output_csv.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(output_csv, index=False)
    return out


def merge_candidates(
    *,
    qa_csv: Path,
    candidates_csv: Path,
    target_total: int = 50,
) -> pd.DataFrame:
    qa = pd.read_csv(qa_csv)
    candidates = pd.read_csv(candidates_csv)
    existing = {normalize_question(str(v)) for v in qa["question"].tolist()}

    rows = qa.to_dict(orient="records")
    for _, row in candidates.iterrows():
        if len(rows) >= target_total:
            break
        normalized = normalize_question(str(row["question"]))
        if normalized in existing:
            continue
        rows.append(
            {
                "question": str(row["question"]).strip(),
                "answer": str(row["answer"]).strip(),
                "category": str(row["category"]).strip(),
                "priority": str(row["priority"]).strip() or "medium",
                "last_updated": str(row["last_updated"]).strip() or DEFAULT_LAST_UPDATED,
            }
        )
        existing.add(normalized)

    merged = pd.DataFrame(rows, columns=REQUIRED_COLUMNS)
    if len(merged) < target_total:
        raise RuntimeError(f"Failed to merge enough candidates. current={len(merged)} target={target_total}")
    merged.to_csv(qa_csv, index=False)
    return merged


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Expand seed FAQ to target size using Gemini and export candidates.")
    parser.add_argument("--input", default="data/gold/faq/qa.csv")
    parser.add_argument("--output", default="data/gold/faq/qa_candidates.csv")
    parser.add_argument("--target-total", type=int, default=50)
    parser.add_argument("--generated-per-seed", type=int, default=6)
    parser.add_argument("--merge", action="store_true", help="Merge candidates into qa.csv up to target-total.")
    return parser


def main() -> None:
    parser = _parser()
    args = parser.parse_args()
    input_csv = Path(args.input)
    output_csv = Path(args.output)

    candidates = expand_faq(
        input_csv=input_csv,
        output_csv=output_csv,
        target_total=args.target_total,
        generated_per_seed=args.generated_per_seed,
    )
    print(f"Generated candidates: {len(candidates)} -> {output_csv}")

    if args.merge:
        merged = merge_candidates(qa_csv=input_csv, candidates_csv=output_csv, target_total=args.target_total)
        by_category = Counter(merged["category"].tolist())
        print(f"Merged qa.csv rows={len(merged)} categories={dict(by_category)}")


if __name__ == "__main__":
    main()
