# Shop AI MVP

4주 매출형 MVP를 위한 단일 카페24 몰 CS 자동화 기본 구현입니다.

## 핵심 기능
- Gold Data(`csv` + `md`) 기반 Pinecone RAG
- GPT-4o Semantic FAQ 확장(`qa_paraphrases.csv` 캐시)
- GPT-4o-mini JSON 의도 분류(`tracking|policy|fallback`)
- Multi-LLM 라우팅 (기본 `Gemini` + 장애/오류 시 `OpenAI` 폴백)
- 임베딩도 `Gemini` 기본 (`models/gemini-embedding-001`, 1536)
- 배송조회 API 툴 연동(재시도/백오프)
- LangGraph 실시간 CS 플로우 + CrewAI 검수 워커(폴백 지원)
- FastAPI `POST /v1/chat/query`
- FastAPI `POST /v1/rag/ingest`
- FastAPI `POST /v1/tools/track-delivery`
- FastAPI `POST /v1/infra/sentry-test`
- FastAPI `GET /ready` (의존성 readiness)
- FastAPI `GET /static/faq_widget.js` (쇼핑몰 임베드 위젯)
- Streamlit 관리자 콘솔
- Render API/Console 분리 배포
- CORS allowlist, request-id, Sentry 기반 관측

## 실행
1. 의존성 설치
```bash
pip install -e .
```

2. 환경변수 준비
```bash
cp .env.example .env
```

3. Supabase 마이그레이션 적용
```sql
\i supabase/migrations/0001_baseline.sql
\i supabase/migrations/0002_fallback_columns.sql
```

4. Gold Data 적재
```bash
python -m app.rag.faq_paraphraser --input data/gold/faq/qa.csv --output data/gold/faq/qa_paraphrases.csv --per-question 5
```

5. Gold Data 적재
```bash
python -m app.rag.ingest --data-root data/gold --version-tag 20260219
```

6. API 실행
```bash
uvicorn app.api.main:app --reload
```

7. 콘솔 실행
```bash
streamlit run console/streamlit_app.py
```

8. E2E 스모크(선택)
```bash
API_BASE_URL=http://127.0.0.1:8000 bash scripts/smoke_e2e.sh
```

9. Fallback 인사이트 리포트(선택)
```bash
python -m app.analytics.fallback_insights --limit 5 --samples 5
```

10. 스키마 검증(선택)
```bash
SUPABASE_DB_URL=postgresql://... python scripts/check_schema.py
```

11. 공개 데모 리허설(선택)
```bash
API_BASE_URL=https://agentr-fz0i.onrender.com bash scripts/demo_public.sh
```

## Render 배포
1. Blueprint
- 파일: `render.yaml`
- 서비스: `shop-ai-api`, `shop-ai-console`

2. API 서비스
- Dockerfile: `Dockerfile.api`
- Start command: `/app/scripts/start_api.sh`
- Health check: `/health`

3. Console 서비스
- Dockerfile: `Dockerfile.console`
- Start command: `/app/scripts/start_console.sh`

4. 필수 환경변수
- API: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `PINECONE_*`, `SUPABASE_*`, `TOKEN_ENCRYPTION_KEY`, `CORS_ALLOWED_ORIGINS`, `SWEETTRACKER_API_KEY`(또는 `DELIVERYAPI_KEY`)
- API(운영): `SENTRY_DSN`, `INFRA_TEST_TOKEN`
- `PINECONE_INDEX_HOST`를 설정하면 ingest/ready에서 제어 플레인 DNS 이슈를 우회할 수 있습니다.
- `CREWAI_REVIEW_ENABLED=false`가 기본이며, `true`로 켜면 LLM 검수 워커를 활성화합니다.
- `EMBEDDING_PROVIDER=gemini`로 두면 OpenAI quota 없이도 벡터 적재를 진행할 수 있습니다.
- Console: `API_BASE_URL`

5. CI Secret
- `RENDER_API_DEPLOY_HOOK_STAGING`
- `RENDER_CONSOLE_DEPLOY_HOOK_STAGING`
- `RENDER_API_DEPLOY_HOOK_PROD`
- `RENDER_CONSOLE_DEPLOY_HOOK_PROD`
- (대체 방식) `RENDER_API_KEY` + `RENDER_API_SERVICE_ID_*` + `RENDER_CONSOLE_SERVICE_ID_*`
- `API_BASE_URL_STAGING`, `API_BASE_URL_PROD`
- `INFRA_TEST_TOKEN_STAGING`, `INFRA_TEST_TOKEN_PROD`

## 데이터 계약
- FAQ: `data/gold/faq/qa.csv`
- FAQ 확장 캐시: `data/gold/faq/qa_paraphrases.csv`
- 정책: `data/gold/policies/*.md`
- 상품: `data/gold/products/product_<sku>.md`

## 참고
- 운영 질의의 색인 대상은 Markdown 문서만 사용합니다.
- 카페24 refresh token은 반드시 DB 암호화 저장 방식만 사용해야 합니다.
- `POST /v1/chat/query` 응답에 `why_fallback`과 `tracking_progress`가 추가됩니다.
- Render 배포 파이프라인은 staging 스모크 성공 시에만 prod 배포를 진행합니다.
- 운영 문서: `docs/infra-runbook.md`, `docs/release-checklist.md`
- 데모 문서: `docs/public-demo-playbook.md`
- 쇼핑몰 임베드 문서: `docs/cafe24-faq-widget.md`
