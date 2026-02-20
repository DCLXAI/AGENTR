# Naver SmartStore API Quickstart

## 1) 환경변수
- `NAVER_COMMERCE_CLIENT_ID`
- `NAVER_COMMERCE_CLIENT_SECRET`
- `NAVER_COMMERCE_BASE_URL` (기본값 `https://api.commerce.naver.com`)
- `NAVER_AUTOREPLY_TOKEN` (선택, 자동답변 엔드포인트 보호용)
- `NAVER_AUTOREPLY_WORKER_ENABLED` (기본 `true`)
- `NAVER_AUTOREPLY_WORKER_INTERVAL_SECONDS` (기본 `15`)
- `NAVER_AUTOREPLY_WORKER_PAGE_SIZE` (기본 `50`)
- `NAVER_AUTOREPLY_WORKER_TENANT_ID` (기본 `tenant-demo`)

## 2) 토큰 발급 검증
```bash
curl -X POST "$API_BASE_URL/v1/tools/naver/token-check"
```

성공 시 `token_type`, `expires_in`이 반환됩니다.

## 3) 문의 조회
```bash
curl "$API_BASE_URL/v1/tools/naver/qnas?page=1&size=20"
```
기본 조회기간은 최근 30일(KST)입니다. 직접 지정하려면:
```bash
curl "$API_BASE_URL/v1/tools/naver/qnas?page=1&size=20&from_date=2026-02-01T00:00:00%2B09:00&to_date=2026-02-20T23:59:59%2B09:00"
```

## 4) 문의 답변
### 4-1. 상품문의(questionId) 답변
```bash
curl -X POST "$API_BASE_URL/v1/tools/naver/qnas/<question_id>/answer" \
  -H "Content-Type: application/json" \
  -d '{"answer":"안녕하세요. 문의 주신 내용 안내드립니다."}'
```

### 4-2. 페이머천트 문의(inquiryNo) 답변
```bash
curl -X POST "$API_BASE_URL/v1/tools/naver/inquiries/<inquiry_no>/answer" \
  -H "Content-Type: application/json" \
  -d '{"answer":"안녕하세요. 문의 주신 내용 안내드립니다."}'
```

## 5) 미답변 문의 1건 자동답변
```bash
curl -X POST "$API_BASE_URL/v1/tools/naver/auto-answer-once" \
  -H "Content-Type: application/json" \
  -H "x-naver-autoreply-token: $NAVER_AUTOREPLY_TOKEN" \
  -d '{"tenant_id":"tenant-demo","session_id_prefix":"naver-auto","dry_run":false}'
```

`dry_run=true`로 먼저 생성 답변만 검증할 수 있습니다.
특정 문의를 강제로 재답변하려면 `question_id`를 지정합니다.
```bash
curl -X POST "$API_BASE_URL/v1/tools/naver/auto-answer-once" \
  -H "Content-Type: application/json" \
  -H "x-naver-autoreply-token: $NAVER_AUTOREPLY_TOKEN" \
  -d '{"tenant_id":"tenant-demo","session_id_prefix":"naver-auto","question_id":"663810138","dry_run":false}'
```

## 6) 미답변 전체 드레인(배치)
```bash
curl -X POST "$API_BASE_URL/v1/tools/naver/auto-answer-drain" \
  -H "Content-Type: application/json" \
  -H "x-naver-autoreply-token: $NAVER_AUTOREPLY_TOKEN" \
  -d '{"tenant_id":"tenant-demo","session_id_prefix":"naver-auto-drain","max_iterations":20,"page":1,"size":50,"dry_run":false}'
```

## 7) 주기 자동화
- 스크립트: `scripts/naver_auto_reply_drain.sh`
- 준실시간 스크립트: `scripts/naver_auto_reply_realtime.sh`
- GitHub Actions: `.github/workflows/naver-auto-reply.yml` (5분 스케줄 + 실행 내 반복 폴링)
- 필수 시크릿: `API_BASE_URL_PROD`, `NAVER_AUTOREPLY_TOKEN`

권장 파라미터:
- `RUN_WINDOW_SECONDS=280`
- `POLL_INTERVAL_SECONDS=20`
- `MAX_ITERATIONS=20`

서버 cron 예시:
```bash
* * * * * cd /path/to/repo && API_BASE_URL=https://agentr-fz0i.onrender.com NAVER_AUTOREPLY_TOKEN=... RUN_WINDOW_SECONDS=55 POLL_INTERVAL_SECONDS=10 bash scripts/naver_auto_reply_realtime.sh >> /var/log/naver_auto_reply.log 2>&1
```

## 8) 서버 24시간 실시간 자동응답(권장)
API 서버 시작 시 백그라운드 워커가 자동 실행되어 미답변 상품문의를 주기적으로 처리합니다.

상태 확인:
```bash
curl "$API_BASE_URL/v1/tools/naver/worker-status"
```

권장:
- 프로덕션 API 인스턴스 수 1 유지
- 워커 주기 10~20초
- 브라우저에는 `NAVER_AUTOREPLY_TOKEN` 노출 금지


## 참고
- 토큰 발급은 Naver Commerce OAuth 규격(`client_secret_sign`)을 사용합니다.
- 실제 문의 엔드포인트의 파라미터/권한은 네이버 앱 권한 설정 상태에 따라 달라질 수 있습니다.
- `NAVER_AUTOREPLY_TOKEN`은 서버/스케줄러에서만 사용하고 브라우저에 노출하지 않습니다.
