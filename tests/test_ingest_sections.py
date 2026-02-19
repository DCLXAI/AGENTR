from pathlib import Path

from app.rag.ingest import collect_gold_documents, parse_markdown_sections


def test_parse_markdown_sections_preserves_header_path() -> None:
    raw = """# A
intro
## B
line1
line2
### C
deep"""
    sections = parse_markdown_sections(raw)
    assert sections[0][0] == "A"
    assert sections[1][0] == "A > B"
    assert sections[2][0] == "A > B > C"


def test_collect_gold_documents_loads_required_metadata() -> None:
    root = Path(__file__).resolve().parents[1] / "data" / "gold"
    docs = collect_gold_documents(root, version_tag="test-v1")
    assert docs, "gold data docs should not be empty"
    sample = docs[0]
    assert "doc_type" in sample.metadata
    assert "source_file" in sample.metadata
    assert "section_path" in sample.metadata
    assert sample.metadata["version_tag"] == "test-v1"
    assert "is_paraphrase" in sample.metadata or sample.metadata["doc_type"] != "faq"


def test_collect_gold_documents_includes_faq_paraphrases() -> None:
    root = Path(__file__).resolve().parents[1] / "data" / "gold"
    docs = collect_gold_documents(root, version_tag="test-v1")
    faq_paraphrases = [doc for doc in docs if doc.metadata.get("doc_type") == "faq" and doc.metadata.get("is_paraphrase")]
    assert faq_paraphrases, "qa_paraphrases.csv should be included in FAQ ingestion"
