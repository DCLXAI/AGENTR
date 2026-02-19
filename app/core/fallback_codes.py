from enum import StrEnum


class FallbackCode(StrEnum):
    CLARIFY_LOW_CONFIDENCE = "clarify_low_confidence"
    TRACKING_MISSING_NUMBER = "tracking_missing_number"
    TRACKING_API_ERROR = "tracking_api_error"
    POLICY_NO_SOURCE = "policy_no_source"
    RAG_NO_SOURCE = "rag_no_source"
    REVIEW_REJECTED = "review_rejected"
    UNSUPPORTED_ACTION = "unsupported_action"
    RUNTIME_CONFIG_MISSING = "runtime_config_missing"

