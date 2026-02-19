# Release Checklist

## Pre-Deploy
- [ ] `pytest -q` 통과
- [ ] `python -m compileall app console tests` 통과
- [ ] Docker 이미지 빌드 성공(`Dockerfile.api`, `Dockerfile.console`)
- [ ] `.env` 필수값 점검(API/Console)
- [ ] Supabase 마이그레이션 적용 완료
- [ ] `scripts/check_schema.py` 통과

## Deploy (Staging -> Prod)
- [ ] staging API 서비스 Railway 배포
- [ ] staging Console 서비스 Railway 배포
- [ ] staging `bash scripts/smoke_e2e.sh` 통과
- [ ] staging `POST /v1/infra/sentry-test` 성공 (`event_id` 기록)
- [ ] prod API 서비스 Railway 배포
- [ ] prod Console 서비스 Railway 배포
- [ ] prod `bash scripts/smoke_e2e.sh` 통과
- [ ] prod `POST /v1/infra/sentry-test` 성공 (`event_id` 기록)
- [ ] 배포 로그에 에러 없음

## Post-Deploy
- [ ] staging/prod 각각 `GET /health` 200
- [ ] staging/prod 각각 `GET /ready.status == ok`
- [ ] 정책 질의에서 `sources>=1`, `why_fallback=null`
- [ ] 운송장 누락 배송 질의에서 `tracking_missing_number`
- [ ] 모든 질의 응답 헤더에 `X-Request-ID` 존재

## Observability
- [ ] staging Sentry `event_id` 확인
- [ ] prod Sentry `event_id` 확인
- [ ] Slack Sentry 채널에서 staging/prod `event_id` 알림 수신
- [ ] 알림 수신 시각/링크/담당자 기록

## Rollback Criteria
- [ ] P0 발생 시 즉시 이전 배포 롤백
- [ ] P1 10분 지속 시 롤백 검토
