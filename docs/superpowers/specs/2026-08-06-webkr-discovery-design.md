# webkr 발견 확장 — 설계

2026-08-06 · M1 홈페이지 발견률 보강 (38.9% → 사람 라벨 상한 61.6% 근접이 목표).
발주자 결정 (2026-08-06): 기준 70% 유지(D-006) 아래에서 소스 보강으로 격차를 좁힌다.
채택 근거는 **텍스트 근거 요구** 안을 선택했다 (판정 전임·2단계 안은 기각).

## 확인된 사실 (2026-08-06)

- **M1 38.9%** `[29.5%, 49.2%]` — 지역검색(`local`) 발견 도입 후 값. 사람 라벨 기준
  실제 존재율은 61.6% 이므로 약 23%p 의 미발견 구간이 남아 있다.
- 지역검색이 못 찾는 전형: 결과 `link` 가 비어 있거나 플레이스·블로그뿐인 업체,
  전화번호가 대표번호와 다른 업체. 이들 중 일부는 웹검색(webkr)에는 공식 사이트가 잡힌다.
- **webkr 히트에는 `telephone`·`address` 필드가 없다** — 지역검색의 채택 근거(전화 일치)를
  그대로 쓸 수 없다. 제목·설명·링크 텍스트가 검증 재료의 전부다.
- `NaverSearchAdapter` 는 webkr 포함 4채널이 실검증돼 있다 (2026-07-31 · fixture 있음).

## 채택 규칙 — 텍스트 근거

지역검색의 "상호 + 시군구 **동시** 일치"(약한 근거)와 동급을 텍스트로 재현한다.

1. 히트의 `title` + `description` 을 정규화(`normalizeCompanyName` 계열)한 문자열에
   - **상호가 포함**되고 — `official.ts` 의 `titleNeedles`(종별 접미 의원·병원 완화,
     한의원 가드 포함)를 **export 해 재사용**한다. "기장필피부과의원" 이
     "기장필피부과" 로 적힌 결과를 놓치지 않기 위해서다.
   - **그리고 시군구도 포함**될 것.
2. `link` 의 도메인이 애그리게이터·SNS·공유 호스트면 **요청 전에 제거**한다
   (`aggregators.ts` 의 기존 분류 재사용 — 지역검색 발견과 같은 규칙).
3. 1·2 를 통과한 히트 중 **최상위 1건만** 채택한다. 검색 순위는 근거가 아니므로
   통과분 안에서의 tie-break 로만 쓴다.
4. `websites.discovery_basis = 'name_region_text'` 로 기록한다 — 골드셋에서 webkr
   채택분의 오분류를 지역검색 채택분(`phone_match`·`name_region_match`)과 분리해
   사후 검증하기 위해서다. `discovery_source` 는 기존과 같이 `naver_search`.

## 범위

### A. 판별 — `packages/pipeline/src/homepageDiscovery.ts`

- `discoverHomepageFromWebSearch(known, hits)` 추가. 위 채택 규칙을 구현하고,
  거절 사유(`no_text_evidence` 등)를 지역검색과 같은 방식으로 돌려준다.
- `official.ts` 의 `titleNeedles` 를 export (이동 없음 — 타이틀 대조 의미가 같다).

### B. 스테이지 — `packages/pipeline/src/stages/homepageDiscover.ts`

- 업체당 흐름: `local` 시도 → **근거가 없어 채택에 실패했을 때만** `webkr` 1회 폴백.
  local 조회 자체가 실패(에러)하면 webkr 를 시도하지 않는다 — 같은 provider 라 함께
  실패할 공산이 크고, 에러는 기존대로 `search_failed` skip 으로 남는다.
  별도 스테이지를 만들지 않는다 (DAG·잡·오케스트레이터 불변).
- 쿼터: 같은 provider 원장 합산 · 호출 전 선점 · 멱등 키
  `discover:webkr:{attemptId}:{companyId}` (local 키와 구분).
- `display` 는 10 — 텍스트 근거 필터라 상위권만 의미가 있다.
- skip 사유 구분: local 과 webkr 의 실패를 별도 카운터로 남긴다
  (`webkr_no_text_evidence` · `webkr_search_failed` 등).

### C. 테스트

- 단위 (`homepageDiscovery.test.ts`): 상호 변형(접미 완화) 매칭 · 시군구 AND 조건 ·
  애그리게이터 사전 제거 · "순위만 높은 무근거 히트" 거절 · 통과분 내 최상위 선택.
- 통합 (`homepageDiscover.pg.test.ts`): local 실패 → webkr 폴백 채택(basis 기록 확인) ·
  **local 성공 시 webkr 미호출**(쿼터 원장으로 확인) · 멱등 · webkr 조회 실패는
  "홈페이지 없음" 으로 기록하지 않음.

## 바뀌지 않는 것

- 발견은 후보를 만들 뿐이다 — 공식 여부는 `homepage_detect` 다신호 판정이 그대로 결정.
- 지역검색의 채택 근거(전화 일치 · 상호+시군구)는 변경 없음. webkr 는 폴백이다.
- 스키마 변경 없음 (`discovery_basis` 는 자유 텍스트 열).
- 어댑터가 없으면(`FEATURE_ORS=off`) 발견 전체가 건너뛴다 — 축소 파이프라인 1급 유지.
- 조회 실패는 우리 실패이지 그 업체의 상태가 아니다 (기록하지 않는다).

## 측정 계획

반영 후 재크롤 → `pnpm spike measure` 로 M1 재측정. `discovery_basis='name_region_text'`
채택분은 골드셋 `label_official_url` 과 대조해 webkr 경로의 정확도를 따로 본다 —
오분류가 나오면 어느 발견 경로 문제인지 즉시 구분된다.

## 범위 밖

- 지역검색 근거 규칙 완화 · 새 외부 소스 발굴 · JS 렌더링 — 별도 논의.
- `webkr` 채택 결과의 ORS 산출 로직 변경 없음 (기존 파이프라인이 그대로 처리).
