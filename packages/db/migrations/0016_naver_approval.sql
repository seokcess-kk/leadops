-- ─────────────────────────────────────────────────────────────────────────────
-- D-002 재확인 (2026-07-31) — 네이버 검색 오픈 API 승인을 코드 레지스트리와 정합시킨다.
--
-- 부팅 게이트는 코드(packages/core/src/sourceRegistry.ts · assertSourceApproved)다.
-- 이 테이블은 감사 기록·운영 폴백 스위치이므로 코드와 어긋나면 안 된다.
-- 0006 시드는 "약관 문언 미검증" 상태의 approved=false 였다 — 전문 확인이 끝났으므로 올린다.
-- 서면 근거: docs/legal/naver-terms-2026-07-31.md (약관 전문 스냅샷 · 발주자 재확인)
-- ─────────────────────────────────────────────────────────────────────────────

update source_registry
set approved = true,
    reviewed_by = '발주자',
    reviewed_at = '2026-07-31',
    note = '약관 전문 확인 완료 (docs/legal/naver-terms-2026-07-31.md · 7.3③/특약2.1/8조). '
           'legacy 엔드포인트는 기존 이용자 지위로 2027-06-30 까지 — 그 전에 API HUB(variant: apihub) 이관 필요. '
           '문제 발생 시 approved=false 로 되돌리면 축소 파이프라인으로 폴백된다.'
where source = 'naver_search';
