# 관측 테이블 월 단위 파티셔닝 — 설계

2026-07-31 · 설계서 4.2 "대응 (P7 완료 기준)" 잔여 항목. Phase 7 에서 코드로 남은 마지막 작업이다.

## 목적

Supabase Free 500MB 는 관측·집계 테이블의 365일 누적을 버티지 못한다 (180일 ≈ 620MB).
row delete 는 즉시 공간을 돌려주지 않는다(bloat) — 파티션 drop 은 파일 삭제라 즉시 회수된다.

## 범위 (발주자 결정 2026-07-31)

| 테이블 | 현재 PK | 현재 unique | 재시도 멱등 upsert |
|---|---|---|---|
| `search_aggregates` | `id bigserial` | `(attempt_id, company_id, keyword, provider)` | `search.ts:230` |
| `company_observations` | `id uuid` | `(company_id, attempt_id)` | `normalize.ts:142` |
| `website_observations` | `id uuid` | `(website_id, attempt_id)` | `homepage.ts:254` |
| `channel_observations` | `id uuid` | `(channel_id, attempt_id)` | `channel.ts:179` |

설계서는 앞의 2개만 명시했으나 **4개 전부** 로 확장한다 — 같은 365일 보관 대상이고
일 증가량이 비슷하다. detach 한 파티션은 **즉시 drop** 한다 — 현재 동작(row delete)과
동등하되 즉시·저비용이고, 백업은 기존 pg_dump 리허설 체계가 담당한다.

## 핵심 결정 — 파티션 키는 `run_date` (기각안: 타임스탬프 키·pg_partman)

파티션 테이블의 unique 제약은 파티션 키를 포함해야 한다. `observed_at`/`collected_at` 을
키로 쓰면 재시도마다 값이 달라 위 표의 upsert 가 전부 무력화된다 — 멱등성이 DB 제약에서
앱 코드로 이동한다. 이 저장소의 원칙(규칙은 DB 가 강제한다)에 어긋나므로 기각.

`run_date date not null` 을 4개 테이블에 추가하고 `partition by range (run_date)` 로 만든다.
값은 `runs.run_date` 에서 온다 — **같은 attempt 의 재시도는 항상 같은 값**이라
`unique (..., run_date)` 의 conflict 가 기존과 동일하게 발화한다.

- **default 를 두지 않는다.** `current_date` 는 UTC 라 KST 06:00 실행에서 `runs.run_date` 와
  다른 날이 된다. 코드가 값을 빠뜨리면 조용히 다른 파티션에 들어가는 대신 not null 위반으로
  즉시 죽는다.
- pg_partman 은 로컬 컨테이너에 없어 검증할 수 없으므로 기각 (pg_cron 을 `deploy/` 로
  분리한 것과 같은 이유). 유지 함수는 plpgsql 로 직접 쓴다.

PG 17 스파이크로 확인한 것: 파티션 부모로의 복합 FK, 파티션 키 포함 unique 의 upsert,
참조 FK 가 있는 상태에서 (참조 행이 없는) 파티션 detach→drop, 복합 FK cascade 삭제.

## 마이그레이션 `0015_partition_observations.sql` (체인 내)

테이블마다 동일한 절차:

1. 기존 테이블을 `<name>_old` 로 rename
2. 파티션 부모 재생성 — 같은 컬럼 + `run_date date not null`,
   PK `(id, run_date)`, unique 는 기존 열 + `run_date`, 기존 보조 인덱스 재생성
3. 기존 데이터가 걸치는 월 + 미래 2개월의 파티션 생성 (`<name>_y2026m07` 명명)
4. `run_attempts → runs` 조인으로 `run_date` 를 채워 `insert ... select` backfill
5. `<name>_old` drop
6. RLS enable + 읽기·워커 정책 + GRANT 재적용 (0003·0005 와 같은 형태)

`search_hits` 는 파티셔닝하지 않지만(30일 보관·소량) FK 를 고친다:
`run_date date` 컬럼 추가 → aggregates 조인으로 backfill → not null 승격 →
기존 `aggregate_id → search_aggregates(id)` FK 를
`(aggregate_id, run_date) → search_aggregates (id, run_date)` 복합 FK 로 교체 (cascade 유지).

`id` 의 bigserial/uuid default 는 부모에 선언한다 (PG 17 에서 파티션에 상속됨).

## 파티션 유지 — `maintain_observation_partitions()`

`security definer` · `search_path` 고정 · **`leadops_worker` 에만 실행권** (authenticated 금지 —
데이터를 지우는 함수다). 4개 부모 각각:

- **선생성**: 현재 달부터 +2개월까지 없는 파티션을 만든다. 새 파티션에 `enable row level
  security` 를 건다 — 스키마 린트(`relkind='r'` 전수 검사)가 자동으로 회귀 감시한다.
- **만료**: 파티션 상한이 `now() - interval '365 days'` 보다 오래된 파티션을
  detach 후 drop 한다. 삭제한 파티션 이름·행수를 반환 jsonb 에 남긴다.

호출 지점 두 곳:

| 지점 | 이유 |
|---|---|
| `cleanup_by_capacity()` 내부 | 기존 정리 경로(워커 cleanup 명령·pg_cron)에 편승 |
| `startRun` (orchestrator.ts:50) 시작 시 | 실행 전에 파티션 존재 보장 — default 파티션을 두지 않으므로(오라우팅 방지, fail-closed) 선생성이 안전망이다 |

기존 row delete 정리는 그대로 둔다 — 120일 공격 모드(85% 이상)는 파티션 경계와 무관하게
동작해야 하고, delete 는 파티션 테이블에서도 유효하다. 365일 경계는 파티션 drop 이 맡는다
(월 단위라 최대 1개월 지연 — 수용).

## 코드 변경 (packages/pipeline)

- `StageContext` 에 `runDate: string` 추가 — 오케스트레이터가 run 을 이미 읽으므로 전달만 한다
- insert 4곳에 `run_date` 명시 + conflict target 에 `run_date` 추가:
  `normalize.ts` · `search.ts`(aggregates 와 hits 양쪽) · `homepage.ts` · `channel.ts`

## 영향 없는 곳

- **API·UI 무변경** — 부모 테이블로 질의하면 파티션은 투명하다
- `db_capacity()` 테이블별 크기에 파티션이 개별 행으로 보인다 — 부모 이름 prefix 로
  식별 가능하므로 수용
- 기존 row delete 정리 함수들 — 파티션 테이블에서 그대로 동작

## 테스트

`packages/db/src/partitions.pg.test.ts` 신규:

1. insert 가 `run_date` 의 월 파티션으로 라우팅된다
2. **같은 attempt 재시도 upsert 가 중복을 만들지 않는다** (4개 테이블 전부 — 이 설계의 존재 이유)
3. 유지 함수가 +2개월을 선생성하고, 새 파티션에 RLS 가 켜져 있다
4. 365일 초과 파티션이 drop 되고 반환 jsonb 에 기록된다
5. `run_attempts` 삭제 cascade · `search_aggregates` 삭제 시 `search_hits` cascade 유지
6. `run_date` 없는 insert 는 에러다 (default 부재 확인)

기존 테스트 수정: 관측 테이블에 직접 insert 하는 pg 테스트 5곳
(`homepage` · `homepageDiscover` · `phase4` · `phase5` 등)에 `run_date` 추가.
기존 RLS 린트·restore-rehearsal(CI)이 파티션 스키마의 복원 가능성을 추가 비용 없이 검증한다.

## 완료 기준

- `pnpm verify` (typecheck + 단위 + DB 통합) 전부 통과
- 신규 파티션 테스트 6항목 통과
- `pnpm worker run` (mock) 이 파티션 스키마 위에서 끝까지 돈다
