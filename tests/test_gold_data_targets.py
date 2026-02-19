from pathlib import Path

import pandas as pd


REQUIRED_QA_COLUMNS = ["question", "answer", "category", "priority", "last_updated"]


def _root() -> Path:
    return Path(__file__).resolve().parents[1]


def _normalize_question(text: str) -> str:
    return " ".join(str(text).strip().lower().split())


def _product_docs_without_placeholder(products_dir: Path) -> list[Path]:
    docs: list[Path] = []
    for path in sorted(products_dir.glob("product_*.md")):
        name = path.name.lower()
        if "<" in name or "template" in name:
            continue
        docs.append(path)
    return docs


def test_gold_faq_target_and_contract() -> None:
    qa_path = _root() / "data" / "gold" / "faq" / "qa.csv"
    qa = pd.read_csv(qa_path)

    assert list(qa.columns) == REQUIRED_QA_COLUMNS
    assert len(qa) >= 50

    normalized = qa["question"].astype(str).map(_normalize_question)
    duplicate_ratio = 1 - (normalized.nunique() / len(qa))
    assert duplicate_ratio <= 0.05


def test_gold_products_target_without_placeholder() -> None:
    products_dir = _root() / "data" / "gold" / "products"
    docs = _product_docs_without_placeholder(products_dir)
    assert len(docs) >= 10


def test_paraphrase_seed_count_matches_faq() -> None:
    qa_path = _root() / "data" / "gold" / "faq" / "qa.csv"
    paraphrase_path = _root() / "data" / "gold" / "faq" / "qa_paraphrases.csv"

    qa = pd.read_csv(qa_path)
    paraphrases = pd.read_csv(paraphrase_path)

    required_paraphrase_columns = {
        "question",
        "answer",
        "category",
        "priority",
        "last_updated",
        "seed_question",
        "seed_question_hash",
        "paraphrase_rank",
        "is_paraphrase",
    }
    assert required_paraphrase_columns.issubset(set(paraphrases.columns))
    assert paraphrases["seed_question_hash"].nunique() == len(qa)
    assert len(paraphrases) == len(qa) * 5

    per_seed = paraphrases.groupby("seed_question_hash").size()
    assert (per_seed == 5).all()
