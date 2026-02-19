# Infra Runbook

## 1. 서비스 구성
- API 서비스: `shop-ai-api` (FastAPI)
- Console 서비스: `shop-ai-console` (Streamlit)
- 배포: Railway (staging -> prod 순차 배포)

## 2. 필수 환경변수
- API
  - `OPENAI_API_KEY`, `GEMINI_API_KEY`
  - `PINECONE_API_KEY`, `PINECONE_INDEX`, `PINECONE_CLOUD`, `PINECONE_REGION`
  - `DELIVERYAPI_KEY` + `DELIVERYAPI_SECRET` 또는 `SWEETTRACKER_API_KEY`
  - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
  - `TOKEN_ENCRYPTION_KEY`
  - `CORS_ALLOWED_ORIGINS`
  - `SENTRY_DSN`
  - `INFRA_TEST_TOKEN`
- Console
  - `API_BASE_URL`

## 3. 배포 시퀀스
1. staging API/Console 배포
2. `bash scripts/smoke_e2e.sh`로 staging 검증
3. `POST /v1/infra/sentry-test` 호출 후 `event_id` 확보
4. staging 통과 시 prod API/Console 배포
5. prod 동일 검증 반복

## 4. 스모크 기준
1. `GET /health` -> 200 + `{"status":"ok"}`
2. `GET /ready` -> `status=ok`
3. `POST /v1/chat/query` 정책 질문 -> `intent=policy`, `sources>=1`, `why_fallback=null`
4. `POST /v1/chat/query` 운송장 누락 배송 질문 -> `why_fallback=tracking_missing_number`
5. `X-Request-ID` 헤더 존재

## 5. Sentry 실수신 검증
1. 요청:
   - `POST /v1/infra/sentry-test`
   - Header: `x-infra-test-token: <INFRA_TEST_TOKEN>`
2. 응답의 `event_id`를 기록
3. Slack Sentry 채널에서 동일 `event_id` 포함 알림 확인
4. Sentry 이벤트 화면에서 동일 `event_id` 확인
5. 검증 로그를 릴리스 체크리스트에 기록

## 6. 장애 우선순위
- P0: 서비스 다운(헬스체크 실패)
- P1: `/ready` fail 지속(5분 이상)
- P2: p95 지연시간 상승/부분 기능 장애

## 7. 공통 대응 절차
1. `/ready.details.failed` 원인 파악
2. 최근 배포/마이그레이션 확인
3. 환경변수 누락/만료 확인
4. Supabase/Pinecone/배송 API 장애 여부 확인
5. 롤백 또는 재배포

## 8. 복구 확인
1. `/health` 200
2. `/ready.status=ok`
3. 스모크 5시나리오 재통과
4. Sentry 테스트 이벤트 1건 재수신
