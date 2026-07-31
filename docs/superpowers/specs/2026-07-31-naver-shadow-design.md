# 네이버 검색 API shadow 가동 — 설계

2026-07-31 · D-002 잔여 리스크(약관 문언·API HUB 이관) 해소 및 `FEATURE_ORS=shadow` 전환.
발주자 결정 (2026-07-31): 약관 문언 확인 후 D-002 "사용 가능" **유지**, shadow 진행.

## 확인된 사실 (2026-07-31)

- **자격증명 동작 확인**: legacy 엔드포인트(`openapi.naver.com/v1/search`) 실호출 200,
  응답 필드가 어댑터 추정 구조와 일치.
- **API HUB 이관 확정** (약관 부칙, 2026-07-31 시행): 개발자센터 Search API 신규 접수는
  2026-07-30 24:00 중단. **기존 이용자(발주자 — 7/30 이전 등록 확인)는 2027-06-30 까지**
  현행 이용 가능. 이후는 API HUB 별도 절차·약관. → **2027년 상반기 내 `variant: "apihub"`
  이관 필요** (어댑터에 옵션 자리는 이미 있음 — 이번 범위 밖).
- **약관 문언** (전문 스냅샷 확보): 7.3③(허용 범위 초과 저장·가공·배포 금지),
  검색 API 특약 2.1(결과 독립 노출·왜곡 금지), 8조(결과 데이터 권리는 회사/원저작자).
  완화 요소 — 본문 미저장(URL·제목·메타만) · 관련 문서 30일 보관 · 집계 중심 · 재배포 없음.
  최종 해석 책임은 발주자 (D-002 기록).

## 범위

### A. 근거·기록

1. **`docs/legal/naver-terms-2026-07-31.md`** — 약관 전문 스냅샷. 메타(원본 URL ·
   수집 일시 · 약관 개정일 2026-07-31) + 전문 + 관련 조항 발췌·평가 요약. 서면 근거의
   실체가 이 파일이다.
2. **`docs/03-decisions.md`** — D-002 절에 "2026-07-31 재확인" 추기: 문언 확인 완료,
   API HUB 기한, 등록 시점 확인, 발주자 유지 결정. 기존 본문은 수정하지 않고 추기만.
3. **`packages/core/src/sourceRegistry.ts`** — `naver_search` 항목:
   `reviewedAt: "2026-07-31"`, note 를 "약관 전문 확인 완료(docs/legal/…) ·
   legacy 기한 2027-06-30 — 그 전에 API HUB 이관 필요" 로 교체.
   `termsUrl`·`allowedUse` 등 나머지는 유지.
4. **마이그레이션 `0016_naver_approval.sql`** — DB `source_registry` 의 `naver_search`
   행을 update: `approved = true`, `reviewed_at = '2026-07-31'`, note 갱신(3과 동일 취지).
   0006 시드는 불변 (이미 적용된 마이그레이션은 고치지 않는다 — 0013 전례).
   ⚠️ 부팅 게이트는 코드 레지스트리(`assertSourceApproved`)다 — DB 는 감사 기록·운영
   폴백 스위치이므로 코드와 정합해야 한다.

### B. 검증 하네스 — `verifyNaver`

`packages/adapters/src/verify.ts` 의 기존 패턴(verifyHira·verifyFtc)을 따른다.

- 4채널 각 1회 실호출: `blog` · `cafe`(cafearticle) · `webkr` · `news`,
  키워드는 임의 지역+업종 1개 (예: "강남 피부과").
- 검사: HTTP 200 · `items` 배열 존재 · 파서(`parseNaverResponse`)가 요구하는 필드
  (`title`·`link`·`description`, blog 는 `postdate`·`bloggerlink`) 존재 · 파서가 실제로
  hits 를 반환.
- **fixture 녹화**: `fixtures/http/naver-search-<channel>.json` (HIRA fixture 와 같은
  위치·명명 관례).
- **자격증명 없으면 skip** (fail 아님) — 검색 어댑터는 선택적이고 축소 파이프라인이
  1급 경로다. `spike verify` 출력에 skip 사유 표기.
- `NaverSearchAdapter.verifiedAgainstLiveApi` → true. 녹화 fixture 기반 회귀 테스트
  추가 (실응답으로 파서 검증 — HIRA 의 fixture 회귀 테스트 전례).

### C. shadow 전환 + 실측

1. `.env` `FEATURE_ORS=off` → `shadow` (로컬 — 커밋 대상 아님. `.env.example` 의
   주석은 D-002 이후 기본 shadow 를 이미 안내하고 있어 무변경).
2. `pnpm spike verify` 전체 실행 — naver pass · HIRA pass · FTC fail(기존 상태) 확인.
3. 표본 재실행: `FEATURE_SOURCE=live pnpm worker run --industry=derm,plastic,dental`
   — `homepage_discover` 가 지역검색으로 URL 후보를 채우고(M1 대응), `search_analyze` 가
   shadow ORS 를 산출·기록한다 (배점 0 유지 — `on` 승격은 Phase 4 확증 검증 통과가 조건,
   D-002 에 명시된 데이터 품질 게이트).
4. `pnpm spike measure --goldset out/sample-seed42.csv` — **M1(발견률, 기존 18.9%)·
   M6(ORS 산출 가능률, 기존 0%)** 재측정. 라벨 의존 지표는 여전히 `미측정` (라벨링 별도).
5. 쿼터: 일 25,000 한도는 호출 전 선점 가드(`cost_ledger` + advisory lock)가 지킨다 —
   표본 90건 규모는 한도 내.

## 범위 밖 (후속)

- 실행별 네이버 쿼터 UI 표시 (shadow 데이터가 쌓인 뒤)
- API HUB 이관 (`variant: "apihub"`) — 2027-06-30 전. 기한이 sourceRegistry note 와
  D-002 추기에 기록되므로 잊히지 않는다.
- 라벨 의존 지표(M2·M3) — 골드셋 라벨링 완료 후.

## 테스트

- verify 하네스: 실호출 검증은 CLI 경로 (`pnpm spike verify`) — CI 에서는 키가 없어
  skip 경로가 동작해야 한다 (skip 이 fail 이 되지 않는 단위 테스트).
- fixture 회귀: 녹화된 실응답으로 `parseNaverResponse` 검증.
- 0016 마이그레이션: `schema.pg.test.ts` 마이그레이션 목록 갱신 + DB naver 행이
  `approved=true` 인지 단정.
- 기존 게이트: `pnpm verify` 전체 green.

## 완료 기준

- `pnpm spike verify` 에서 naver **pass** + fixture 4개 녹화됨
- `FEATURE_ORS=shadow` 로 워커가 부팅되고 실행이 끝까지 돈다 (search_analyze 가 skip 이
  아니라 산출)
- `pnpm spike measure` 가 M1·M6 재측정값을 보고한다
- `pnpm verify` 전체 green
