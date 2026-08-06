-- ═══════════════════════════════════════════════════════════════════════════
-- webkr 폴백 근거 — discovery_basis 허용값에 name_region_text 추가
--
-- 0014 는 discovery_basis 를 phone_match·name_and_region_match 두 값으로 제한했다.
-- webkr 폴백(설계서 2026-08-06)은 지역검색과 달리 전화·주소가 없어 텍스트로
-- 근거를 재현한다 — 상호(접미 완화)와 시군구가 제목+설명에 함께 나타나야 채택한다
-- (`discoverHomepageFromWebSearch`). 그 결과를 `name_region_text` 로 기록해야
-- 사후에 basis 별로 정확도를 나눠 검증할 수 있다. 기존 제약대로면 이 값이 그대로
-- 거부되어 웹검색 폴백이 저장 단계에서 전부 실패한다.
-- ═══════════════════════════════════════════════════════════════════════════

alter table websites drop constraint if exists websites_discovery_needs_basis;
alter table websites add constraint websites_discovery_needs_basis check (
  discovery_source is null
  or discovery_basis in ('phone_match', 'name_and_region_match', 'name_region_text')
);

comment on column websites.discovery_basis is
  '검색 결과를 그 업체 것으로 판단한 근거. phone_match(강) | name_and_region_match(약) | name_region_text(webkr 폴백 · 텍스트).';
