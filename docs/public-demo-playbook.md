# Public Demo Playbook

## Goal
- 5~10분 안에 MVP 핵심 가치 3가지를 보여준다.
- 정확한 정책 답변(RAG), 배송 문의 처리, fallback 안전장치를 실시간으로 증명한다.

## Demo URL
- API: `https://agentr-fz0i.onrender.com`
- Swagger: `https://agentr-fz0i.onrender.com/docs`

## T-30 Checklist
1. API 워밍업
```bash
curl https://agentr-fz0i.onrender.com/health
curl https://agentr-fz0i.onrender.com/ready
```
2. 데모 리허설 자동 실행
```bash
API_BASE_URL=https://agentr-fz0i.onrender.com bash scripts/demo_public.sh
```
3. 콘솔 UI 준비
```bash
API_BASE_URL=https://agentr-fz0i.onrender.com streamlit run console/streamlit_app.py
```

## Live Script (권장 순서)
1. 상태 확인
- 콘솔 좌측 `상태 점검` 버튼 실행
- `/health`, `/ready`가 응답되는지 먼저 보여준다.

2. 정책 답변 데모
- 시나리오: `정책 답변 (RAG)` 불러오기
- 기대 포인트:
  - `intent=policy`
  - `sources`가 1개 이상
  - `why_fallback=null`

3. 배송 문의 데모 (운송장 누락)
- 시나리오: `배송조회 (운송장 누락)` 불러오기
- 기대 포인트:
  - 추측 답변 금지
  - `why_fallback=tracking_missing_number`
  - 고객에게 추가정보(운송장) 요청

4. 권한 밖 요청 데모
- 시나리오: `권한 밖 요청 차단` 불러오기
- 기대 포인트:
  - 주문 취소/변경 자동 실행 차단
  - `why_fallback`은 운영 설정에 따라 `unsupported_action` 또는 `review_rejected`
  - 안전한 안내 + 사람 개입 경로

## Failure Talk Track
- 콜드스타트 지연:
  - "무료 플랜 특성상 첫 호출은 10~40초 지연될 수 있고, 이후는 정상 속도로 동작합니다."
- `ready=degraded`:
  - "외부 의존성 타임아웃 시 degraded를 내보내고, 사용자 응답은 안전 fallback으로 보호합니다."

## Evidence Pack
- 자동 리허설 결과 파일:
  - `artifacts/demo/<timestamp>/summary.json`
  - `artifacts/demo/<timestamp>/chat_policy.json`
  - `artifacts/demo/<timestamp>/chat_tracking_missing.json`
  - `artifacts/demo/<timestamp>/chat_unsupported_action.json`
