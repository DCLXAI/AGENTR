# Gold Data Review Checklist

## FAQ (`data/gold/faq/qa.csv`)
- [ ] 필수 컬럼(`question,answer,category,priority,last_updated`)이 모두 존재한다.
- [ ] 질문 원본이 50개 이상이며 중복 질문이 없다.
- [ ] 카테고리(`shipping, policy, order, membership, product`)가 모두 포함된다.
- [ ] 정책 숫자(예: 7일, 50,000원, 6,000원, 12개월)가 기존 운영 정책과 일치한다.
- [ ] 불확실한 문장(추정/권장/아마 등) 없이 단정형 답변으로 정리되어 있다.

## 상품 Markdown (`data/gold/products/*.md`)
- [ ] placeholder(`product_<sku>.md`)를 제외하고 10개 이상 존재한다.
- [ ] 각 파일이 아래 헤더를 모두 포함한다.
  - [ ] `# 상품명 (SKU)`
  - [ ] `## 1. 상품 개요`
  - [ ] `## 2. 사이즈 가이드`
  - [ ] `## 3. 세탁 방법`
  - [ ] `## 4. 교환/반품 참고`
- [ ] 데모 데이터 문구가 포함되어 실제 운영 데이터와 혼동되지 않는다.

## Paraphrase / Ingest
- [ ] `qa_paraphrases.csv`의 seed unique가 `qa.csv` 질문 unique와 동일하다.
- [ ] seed당 paraphrase 개수가 5개로 유지된다.
- [ ] ingest 실행 후 Pinecone `total_vector_count`가 증가했다.

## 샘플 질의 확인
- [ ] 정책 질문 20개 샘플에서 `sources>=1` 비율이 95% 이상이다.
- [ ] 근거 부족 질문은 `확인 불가`로 응답한다.
- [ ] 배송 질문(운송장 미입력)은 `tracking_missing_number`로 폴백한다.
