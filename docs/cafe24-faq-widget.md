# Cafe24 FAQ Widget Quickstart

## Goal
- 쇼핑몰 페이지에 FAQ 챗 위젯을 붙여서 고객 질문을 자동 응답한다.
- 질문 처리는 `POST /v1/chat/query`로 연결된다.

## 1) 사전 조건
1. API가 배포되어 있어야 한다.
2. `CORS_ALLOWED_ORIGINS`에 쇼핑몰 도메인이 포함되어야 한다.
3. `tenant_id`가 정해져 있어야 한다(예: `tenant-demo`).

## 2) Cafe24에 붙이는 스니펫
아래 코드를 스킨 공통 footer(또는 공통 JS 영역)에 추가한다.

```html
<script
  src="https://agentr-fz0i.onrender.com/static/faq_widget.js"
  data-api-base-url="https://agentr-fz0i.onrender.com"
  data-tenant-id="tenant-demo"
  data-title="고객센터 AI"
  data-open-label="문의"
  data-placeholder="배송/반품/교환/상품 질문을 입력하세요"
  data-welcome="안녕하세요. 배송/반품/교환/상품 문의를 빠르게 도와드릴게요."
></script>
```

## 3) 동작 확인
1. 쇼핑몰 페이지 우하단에 버튼(`문의`)이 보여야 한다.
2. 클릭 후 질문 입력:
   - `반품은 수령 후 며칠 이내에 가능하나요?`
   - `운송장번호 없이 배송조회 해줘`
3. 네트워크 탭에서 `POST /v1/chat/query` 200을 확인한다.

## 4) 자주 막히는 항목
1. CORS 에러:
   - API `CORS_ALLOWED_ORIGINS`에 쇼핑몰 도메인을 추가
2. 500/timeout:
   - `/ready` 상태와 Pinecone/Supabase 연결 상태 점검
3. 의도 분류 오작동:
   - `data/gold/faq/qa.csv` 문항/카테고리 보강 후 재색인

## 5) 운영 팁
1. 첫 방문 콜드스타트 지연을 줄이려면 무료 플랜보다 상위 플랜을 사용한다.
2. `why_fallback` 로그를 주간 리포트로 뽑아 정책 문서를 보강한다.

