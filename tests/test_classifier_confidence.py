from app.core.config import Settings
from app.services import classifier


def _settings() -> Settings:
    return Settings(
        app_env="dev",
        service_name="api",
        openai_api_key="x",
        gemini_api_key="y",
    )


def test_classifier_backfills_tracking_confidence_and_number(monkeypatch) -> None:
    monkeypatch.setattr(
        classifier,
        "invoke_with_fallback",
        lambda **kwargs: classifier.IntentClassification(
            intent="tracking",
            confidence=0.0,
            entities=classifier.IntentEntities(),
        ),
    )
    clf = classifier.IntentClassifier(_settings())
    out = clf.classify("운송장 123456789012 배송 조회해줘")
    assert out.confidence > 0.9
    assert out.entities.tracking_number == "123456789012"


def test_classifier_backfills_policy_confidence(monkeypatch) -> None:
    monkeypatch.setattr(
        classifier,
        "invoke_with_fallback",
        lambda **kwargs: classifier.IntentClassification(
            intent="policy",
            confidence=0.0,
            entities=classifier.IntentEntities(),
        ),
    )
    clf = classifier.IntentClassifier(_settings())
    out = clf.classify("반품 정책 알려줘")
    assert out.confidence >= 0.8
