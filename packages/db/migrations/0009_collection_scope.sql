-- 수집 범위 설정 (발주자 결정 2026-07-30)
--
-- HIRA 는 같은 업종을 두 방식으로 셀 수 있고, 그 차이가 **10배**다.
--
--   name       기관명에 과목명이 든 곳    피부과 1,555 / 성형외과 1,236
--   specialty  그 과목을 신고한 곳        피부과 16,987 / 성형외과 4,883
--
-- 피부과는 **전체 의원의 45%** 가 진료과목으로 신고한다(37,819 중 16,987).
-- specialty 로 모으면 피부 시술을 겸하는 일반의원이 대량 섞여 "피부과 마케팅" 제안이
-- 맞지 않는 리드가 된다. 발주자가 `name` 을 선택했다.
--
-- ❗ 코드에 박지 않고 설정으로 두는 이유: 되돌릴 수 있어야 한다.
--    좁힌 뒤 모집단이 너무 빨리 소진되면 넓히는 것이 유일한 대응인데,
--    그때 코드 배포가 필요하면 대응이 늦는다. (privacy.default_contact_basis 와 같은 원칙)

insert into settings (key, value) values
  ('collection', jsonb_build_object(
     'hira_scope', 'name'
   ))
on conflict (key) do nothing;

comment on table settings is
  '실행 시작 시점에 스냅샷으로 동결된다. 실행 중 값이 바뀌어도 진행 중인 실행은 영향받지 않는다.';
