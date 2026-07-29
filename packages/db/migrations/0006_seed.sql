-- 초기 설정과 소스 레지스트리 시드
-- 값은 설계서 1.4 / 4.x / 부록 A 와 docs/03-decisions.md 를 따른다.

insert into settings (key, value) values
  ('targets', jsonb_build_object(
     'raw_min', 300,
     'raw_max', 500,
     'basic_pass', 175,
     'review_max', 100,
     -- 결론 E: 50 은 목표가 아니라 **상한**이다. 실 처리량은 Phase 0 실측으로 확정한다.
     'final_max', 50,
     'industry_share_max', 0.6,
     -- 결론 D: cooldown 은 재진입의 필요조건이지 충분조건이 아니다.
     --         변경이 감지되지 않은 업체는 만료돼도 다시 돌지 않는다.
     'cooldown_rejected_days', 90,
     'cooldown_excluded_days', 180,
     'cooldown_recontact_days', 365,
     'rescan_ratio', 0.3
   )),
  ('scoring', jsonb_build_object(
     -- 모드 B (ORS 비활성) 기준. ORS 활성 시 axis_problem 만점이 60 으로 커진다.
     'mode', 'ors_disabled',
     'axis_problem_min', 15,
     'axis_propensity_min', 10,
     'axis_confidence_min', 9,
     'total_min_normalized', 60,
     'rule_version', 'v3-2026-07-29'
   )),
  ('quota', jsonb_build_object(
     'naver_daily_cap', 20000,
     'data_go_kr_daily_cap', 9000,
     'youtube_daily_units', 9000
   )),
  ('cost', jsonb_build_object(
     'daily_cap_krw', 2000,
     'llm_monthly_cap_krw', 15000
   )),
  ('privacy', jsonb_build_object(
     'lead_retention_days', 365,
     'email_retention_days', 365,
     -- D-001: 발주자가 콜드 아웃바운드를 적법하다고 판단했다.
     -- 되돌릴 수 있도록 **설정값**으로 둔다. 'pending_legal_review' 로 바꾸면
     -- 그 시점 이후 승인분은 export 게이트에서 자동으로 걸린다.
     'default_contact_basis', 'legitimate_interest_claimed'
   )),
  ('review', jsonb_build_object(
     'manual_email_per_minute', 3,
     'nonce_ttl_minutes', 30
   )),
  ('export', jsonb_build_object(
     'max_per_lead', 3
   )),
  ('schedule', jsonb_build_object(
     'enabled', true,
     'cron', '0 21 * * 0-4',   -- UTC 21:00 = KST 06:00 다음날 (월~금)
     'timezone', 'Asia/Seoul'
   ))
on conflict (key) do nothing;

insert into source_registry
  (source, label, terms_url, legal_basis, allowed_use, redistribution_allowed,
   approved, written_approval_ref, reviewed_by, reviewed_at, note)
values
  ('hira_hospital', '건강보험심사평가원 병원정보서비스',
   'https://www.data.go.kr/data/15001698/openapi.do',
   '공공데이터법에 따른 공공데이터 개방 · 포털 이용약관 동의',
   '영리·비영리 목적 이용 가능 (출처 표시)',
   true, true, null, 'system', '2026-07-29', null),

  ('ftc_franchise', '공정거래위원회 가맹정보',
   'https://www.data.go.kr/data/15125467/openapi.do',
   '공공데이터법에 따른 공공데이터 개방',
   '영리·비영리 목적 이용 가능 (출처 표시)',
   true, true, null, 'system', '2026-07-29', null),

  ('nts_bizstatus', '국세청 사업자등록 상태조회',
   'https://www.data.go.kr/data/15081808/openapi.do',
   '공공데이터법에 따른 공공데이터 개방',
   '사업자등록 상태 확인 목적',
   false, true, null, 'system', '2026-07-29', null),

  ('naver_search', '네이버 검색 오픈 API',
   'https://developers.naver.com/products/terms/',
   '네이버 API 이용약관',
   '사내 리드 발굴 분석 (결과 원문 재배포 금지)',
   false, true, 'D-002', '발주자', '2026-07-29',
   '약관 조항 문언 미검증. Phase -1 에서 전문 확인 필요. 문제 발생 시 approved=false 로 되돌리면 축소 파이프라인으로 폴백된다.'),

  ('youtube_data', 'YouTube Data API v3',
   null,
   'Google API 서비스 약관',
   'channels.list(1 unit) 만 사용. search.list(100 unit) 사용 금지',
   false, true, null, 'system', '2026-07-29', null),

  ('target_homepage', '대상 업체 공식 홈페이지 직접 fetch',
   null,
   '공개된 웹 페이지 열람 · robots.txt 준수',
   '공식 여부 판별 · 연락처 페이지 링크 탐지 · 기술 신호. 이메일 추출 금지',
   false, true, null, 'system', '2026-07-29',
   '정보통신망법 제50조의2: 이메일 문자열 추출을 하지 않는다. 연락처 페이지는 링크만 탐지하고 본문을 fetch 하지 않는다.')
on conflict (source) do nothing;
