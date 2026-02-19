import json
import os

import requests
import streamlit as st

from app.core.config import get_settings


get_settings().validate_runtime()


def render_tracking_ui(tracking_progress: dict | None) -> None:
    st.subheader("배송 진행 상태")
    if not tracking_progress:
        st.info("배송 진행 정보 없음")
        return

    stage = tracking_progress.get("stage")
    raw_status = tracking_progress.get("raw_status")
    if stage is None:
        if raw_status:
            st.info(f"현재 배송 상태: {raw_status} (진행단계 매핑 미정)")
        else:
            st.info("배송 상태 매핑 정보 없음")
        return

    stages = ["결제완료", "배송중", "배송완료"]
    cols = st.columns(3)
    for idx, name in enumerate(stages, start=1):
        if idx <= int(stage):
            cols[idx - 1].success(name)
        else:
            cols[idx - 1].caption(name)
    st.progress(int(stage) / 3)
    st.caption(f"상세 상태: {raw_status or '-'}")


st.set_page_config(page_title="Shop AI Console", layout="wide")
st.title("Shop AI 관리자 콘솔")
st.caption("단일 카페24 몰 기준 MVP 운영 콘솔")

with st.sidebar:
    api_base_url = st.text_input("API Base URL", value=os.getenv("API_BASE_URL", "http://127.0.0.1:8000"))
    tenant_id = st.text_input("Tenant ID", value="tenant-demo")
    session_id = st.text_input("Session ID", value="session-demo")

question = st.text_area("고객 질문", height=140, placeholder="예: 운송장 123456789012 배송 어디쯤인가요?")

if st.button("질문 실행", type="primary"):
    if not question.strip():
        st.warning("질문을 입력해 주세요.")
    else:
        payload = {
            "tenant_id": tenant_id,
            "session_id": session_id,
            "user_message": question.strip(),
        }
        try:
            response = requests.post(f"{api_base_url.rstrip('/')}/v1/chat/query", json=payload, timeout=30)
            response.raise_for_status()
            data = response.json()
        except Exception as exc:
            st.error(f"요청 실패: {exc}")
        else:
            st.subheader("AI 답변")
            st.write(data.get("answer", ""))
            st.write(
                f"intent=`{data.get('intent')}` "
                f"confidence=`{data.get('confidence')}` "
                f"needs_human=`{data.get('needs_human')}` "
                f"why_fallback=`{data.get('why_fallback')}`"
            )
            render_tracking_ui(data.get("tracking_progress"))

            st.subheader("출처")
            sources = data.get("sources", [])
            if not sources:
                st.info("출처 없음")
            for src in sources:
                st.markdown(f"- **{src.get('title')}**")
                st.caption(src.get("snippet", ""))

            st.subheader("Tool Trace")
            tool_trace = data.get("tool_trace", [])
            if tool_trace:
                st.json(tool_trace)
            else:
                st.info("툴 호출 없음")

            with st.expander("Raw JSON"):
                st.code(json.dumps(data, ensure_ascii=False, indent=2), language="json")
