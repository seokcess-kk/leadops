-- ═══════════════════════════════════════════════════════════════════════════
-- 홈페이지 발견 출처 (설계서 3.2 · M1 소스 보강)
--
-- HIRA 의 `hospUrl` 은 실측 **20.8%** 만 채워져 있다 (2026-07-30 · 표본 900건).
-- 나머지는 평가할 URL 자체가 없어 판정 단계가 `no_homepage_url` 로 건너뛴다.
-- 지역검색으로 후보를 찾아 채우되, **어디서 온 URL 인지**를 함께 남긴다.
--
-- ❗ 출처를 남기지 않으면 오판을 사후에 되짚을 수 없다. 공공 API 가 준 URL 과 검색으로
--    찾은 URL 은 신뢰도가 다르고, 골드셋에서 오분류가 나왔을 때 어느 쪽 문제인지
--    구분할 수 있어야 규칙을 고칠 수 있다 (M2 미달 대응 = "신호 가중치 조정").
-- ═══════════════════════════════════════════════════════════════════════════

alter table websites
  -- 어느 소스가 이 URL 을 주었나. null 이면 1차 수집원(`hospUrl`) 이다.
  add column if not exists discovery_source text,
  -- 검색으로 찾았다면 **무슨 근거로** 그 업체 것이라고 판단했나.
  --   phone_match           공공 API 대표번호와 일치 (강한 근거)
  --   name_and_region_match 상호와 시군구가 둘 다 일치 (약한 근거)
  add column if not exists discovery_basis text,
  add column if not exists discovered_at timestamptz;

-- ❗ 근거 없이 발견 출처만 남는 상태를 막는다. 근거를 적지 않으면 나중에 그 URL 을
--    왜 채택했는지 알 수 없고, 그러면 규칙을 고칠 근거도 사라진다.
alter table websites drop constraint if exists websites_discovery_needs_basis;
alter table websites add constraint websites_discovery_needs_basis check (
  discovery_source is null
  or discovery_basis in ('phone_match', 'name_and_region_match')
);

-- 발견된 URL 은 `discovered_at` 이 있어야 한다 (언제 찾았는지 모르면 재검증 시점을 정할 수 없다).
alter table websites drop constraint if exists websites_discovery_needs_time;
alter table websites add constraint websites_discovery_needs_time check (
  discovery_source is null or discovered_at is not null
);

comment on column websites.discovery_source is
  '이 URL 을 준 소스. null 이면 1차 수집원(hospUrl). 검색으로 찾았으면 어댑터 이름.';
comment on column websites.discovery_basis is
  '검색 결과를 그 업체 것으로 판단한 근거. phone_match(강) | name_and_region_match(약).';

-- ❗ `on conflict (company_id, domain)` 을 쓰려면 그 조합에 유일 제약이 있어야 한다.
--    기존 제약은 (company_id, canonical_url) 이라, 같은 도메인의 다른 경로가 중복 적재된다
--    (`https://a.kr` 와 `https://a.kr/` 가 별개 행이 된다).
create unique index if not exists websites_company_domain on websites (company_id, domain);
