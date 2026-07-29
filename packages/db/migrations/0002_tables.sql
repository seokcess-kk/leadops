-- 테이블 (설계서 6.2 · v3)

-- ─────────────────────────────────────────────────────────── 권한
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role user_role not null default 'user',
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────── 소스 레지스트리 (F-25 · R2-02)
create table source_registry (
  source text primary key,
  label text not null,
  terms_url text,
  legal_basis text not null,
  allowed_use text not null,
  redistribution_allowed boolean not null default false,
  approved boolean not null default false,
  -- 서면 허용 근거. 없으면 ORS 계열 어댑터는 부팅을 거부한다.
  written_approval_ref text,
  reviewed_by text,
  reviewed_at date,
  note text
);

-- ─────────────────────────────────────────────────────────── 실행
create table runs (
  id uuid primary key default gen_random_uuid(),
  run_date date not null,
  trigger text not null check (trigger in ('cron', 'manual', 'retry')),
  status run_status not null default 'queued',
  settings_snapshot jsonb not null,
  counts jsonb not null default '{}'::jsonb,
  cost_krw numeric(10, 2) not null default 0,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
-- F-18: created_at 을 포함한 유일키는 중복 cron 을 전혀 막지 못한다. 부분 유일 인덱스로.
create unique index runs_one_cron_per_day on runs (run_date) where trigger = 'cron';
create index runs_by_date on runs (run_date desc, created_at desc);

-- R2-21: 실행 시도를 1급 엔터티로. 재실행 시 새 attempt 로 결과를 다시 만든다.
create table run_attempts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  attempt_no int not null check (attempt_no >= 1),
  from_stage text,
  created_at timestamptz not null default now(),
  unique (run_id, attempt_no),
  -- 하위 테이블이 (attempt_id, run_id) 복합 FK 로 소속을 보장하기 위한 대상
  unique (id, run_id)
);

create table run_stages (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references run_attempts(id) on delete cascade,
  stage text not null,
  status stage_status not null default 'pending',
  total int not null default 0,
  done int not null default 0,
  failed int not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  unique (attempt_id, stage)
);

-- ─────────────────────────────────────────────────────────── 잡 큐 (F-15 · R2-24)
create table jobs (
  id bigserial primary key,
  attempt_id uuid not null references run_attempts(id) on delete cascade,
  stage text not null,
  idempotency_key text not null,
  payload jsonb not null,
  status job_status not null default 'queued',
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_after timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  fence_token bigint not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  unique (attempt_id, stage, idempotency_key)
);
create index jobs_ready on jobs (run_after) where status = 'queued';
create index jobs_expired on jobs (lease_expires_at) where status = 'running';

-- ─────────────────────────────────────────────────────────── 업체
create table company_groups (
  id uuid primary key default gen_random_uuid(),
  group_key text unique not null,
  kind text not null check (kind in ('corporation', 'brand', 'network')),
  display_name text not null
);

create table companies (
  id uuid primary key default gen_random_uuid(),
  group_id uuid references company_groups(id) on delete set null,
  dedupe_key text unique not null,
  name text not null,
  normalized_name text not null,
  industry text not null,
  biz_no text,
  corp_no text,
  region_sido text,
  region_sigungu text,
  region_dong text,
  address text,
  phone text,
  lat numeric,
  lng numeric,
  status company_status not null default 'unknown',
  status_source text,
  closed_at date,
  size_tier text check (size_tier is null or size_tier in ('small', 'mid', 'large')),
  size_signals jsonb not null default '{}'::jsonb,
  is_headquarters boolean not null default false,
  excluded_reason text,
  -- 결론 D: 재검색 제어
  last_scanned_at timestamptz,
  next_eligible_at timestamptz,
  scan_count int not null default 0,
  content_fingerprint text,
  -- 수신거부는 어떤 결정보다 우선한다 (docs/03-decisions.md)
  do_not_contact boolean not null default false,
  opt_out_at timestamptz,
  retention_until date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index companies_eligible on companies (next_eligible_at)
  where excluded_reason is null and do_not_contact = false;
create index companies_industry on companies (industry);

create table company_observations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  attempt_id uuid not null references run_attempts(id) on delete cascade,
  observed_at timestamptz not null default now(),
  status company_status not null,
  content_fingerprint text,
  change_detected boolean not null default false,
  -- new: 이번에 처음 본 업체 / changed: 다시 봤는데 내용이 바뀜
  -- unchanged: 다시 봤고 그대로 / recontact: 과거 승인 이력이 있어 재접촉 대상
  track text not null check (track in ('new', 'changed', 'unchanged', 'recontact')),
  summary jsonb not null default '{}'::jsonb,
  unique (company_id, attempt_id)
);
create index company_observations_cleanup on company_observations (observed_at);

-- ─────────────────────────────────────────────────────────── 홈페이지
create table websites (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  canonical_url text not null,
  domain text not null,
  unique (company_id, canonical_url)
);
create index websites_domain on websites (domain);

create table website_observations (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references websites(id) on delete cascade,
  attempt_id uuid not null references run_attempts(id) on delete cascade,
  observed_at timestamptz not null default now(),
  official_status official_status not null,
  official_score numeric(5, 2),
  signals jsonb not null default '{}'::jsonb,
  robots_allowed boolean,
  -- F-25: noindex 는 색인 지시이지 fetch 금지가 아니다. 차단 사유가 아니라 메타데이터.
  has_noindex boolean,
  has_contact_form_only boolean,
  http_status int,
  tech_signals jsonb not null default '{}'::jsonb,
  crawled_pages int not null default 0,
  content_hash text,
  unique (website_id, attempt_id)
);

-- 연락처 페이지 후보 (설계서 결론 A · R2-07)
-- ❗ 이메일 문자열을 저장하지 않을 뿐 아니라 이 URL 의 **본문을 fetch·캐시하지 않는다**.
--    탐지는 상위 페이지의 링크 URL·앵커 텍스트만으로 한다. 본문은 검수자 브라우저만 가져온다.
create table contact_pages (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references websites(id) on delete cascade,
  attempt_id uuid not null references run_attempts(id) on delete cascade,
  url text not null,
  page_kind text not null
    check (page_kind in ('contact', 'about', 'privacy', 'terms', 'footer', 'partnership')),
  link_text text,
  confidence numeric(4, 3),
  body_fetched boolean not null default false
    constraint contact_body_never_fetched check (body_fetched = false),
  unique (website_id, attempt_id, url)
);

-- ─────────────────────────────────────────────────────────── 이메일
create table emails (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  address extensions.citext not null,
  local_part text not null,
  domain text not null,
  email_type email_type not null default 'unknown',
  acquisition_method acquisition_method not null,
  collection_legal_basis collection_basis not null,
  entered_by uuid references profiles(id),
  entered_at timestamptz,
  source_contact_page_id uuid references contact_pages(id) on delete set null,
  source_api text,
  domain_match boolean not null default false,
  is_free_mail boolean not null default false,
  syntax_ok boolean,
  dns_ok boolean,
  mx_ok boolean,
  mx_hosts text[],
  verified_at timestamptz,
  confidence numeric(4, 3),
  is_personal_data boolean not null,
  retention_until date not null,
  legal_hold boolean not null default false,
  created_at timestamptz not null default now(),
  unique (company_id, address),
  -- R2-08: manual_entry 는 라벨이 아니라 증거여야 한다. 행위자·시각·본 페이지를 함께 요구한다.
  constraint manual_needs_evidence check (
    acquisition_method <> 'manual_entry'
    or (entered_by is not null and entered_at is not null and source_contact_page_id is not null)
  ),
  constraint api_needs_source check (
    acquisition_method <> 'public_api' or source_api is not null
  )
);

-- F-16: 여러 발견 위치의 provenance 를 잃지 않는다.
create table email_occurrences (
  id bigserial primary key,
  email_id uuid not null references emails(id) on delete cascade,
  found_url text not null,
  found_location text,
  observed_at timestamptz not null default now(),
  unique (email_id, found_url)
);

-- ─────────────────────────────────────────────────────────── 키워드
create table company_keywords (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  keyword text not null,
  kind text not null check (kind in ('brand', 'nonbrand_core', 'nonbrand_long')),
  priority int not null default 0,
  source text not null check (source in ('template', 'llm', 'manual')),
  -- LLM 초안 키워드는 승인 전까지 사용하지 않는다 (설계서 8.2)
  approved boolean not null default false,
  unique (company_id, keyword)
);

-- ─────────────────────────────────────────────────────────── 검색 (R2-09 · R2-11 · R2-14)
create table search_aggregates (
  id bigserial primary key,
  attempt_id uuid not null references run_attempts(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  keyword text not null,
  keyword_kind text not null check (keyword_kind in ('brand', 'nonbrand')),
  provider text not null,
  total_returned int not null,
  -- R2-09: 고정 30 이 아니라 min(30, total_returned)
  denominator int not null check (denominator > 0),
  related_count int not null,
  official_count int not null,
  recency_dist jsonb not null default '{}'::jsonb,
  -- R2-14: 음성 결과도 사후 감사할 수 있게 URL 해시와 분류기 버전을 남긴다
  all_url_hashes text[] not null default '{}',
  classifier_version text not null,
  ors numeric(5, 4),
  collected_at timestamptz not null default now(),
  unique (attempt_id, company_id, keyword, provider)
);
create index search_aggregates_cleanup on search_aggregates (collected_at);

create table search_hits (
  id bigserial primary key,
  aggregate_id bigint not null references search_aggregates(id) on delete cascade,
  -- 채널 간 중복 제거를 위해 상위 키를 비정규화해서 보유한다
  attempt_id uuid not null,
  company_id uuid not null,
  keyword text not null,
  rank int not null,
  channel_type channel_type not null,
  is_official boolean not null default false,
  url text not null,
  url_hash text not null,
  title text,
  published_at date,
  recency recency_bucket not null default 'unknown',
  collected_at timestamptz not null default now(),
  -- R2-09: provider 가 아니라 (attempt, company, keyword) 기준이라 채널 간 중복이 제거된다
  unique (attempt_id, company_id, keyword, url_hash)
);
create index search_hits_cleanup on search_hits (collected_at);

-- ─────────────────────────────────────────────────────────── 공식 채널
create table channels (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  type channel_type not null,
  url text not null,
  unique (company_id, type, url)
);

create table channel_observations (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references channels(id) on delete cascade,
  attempt_id uuid not null references run_attempts(id) on delete cascade,
  is_active boolean,
  last_post_at date,
  posts_60d int,
  posts_120d int,
  cadence_days numeric(6, 2),
  content_mix jsonb not null default '{}'::jsonb,
  analyzable boolean not null default true,
  unavailable_reason text,
  observed_at timestamptz not null default now(),
  unique (channel_id, attempt_id)
);

-- ─────────────────────────────────────────────────────────── 경쟁사 (F-23)
create table competitors (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references run_attempts(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  competitor_company_id uuid references companies(id) on delete set null,
  competitor_name text not null,
  competitor_url text,
  selection_method text not null,
  similarity jsonb not null default '{}'::jsonb,
  rank int not null check (rank between 1 and 10),
  is_valid boolean not null default false,
  unique (attempt_id, company_id, rank),
  unique (attempt_id, company_id, competitor_company_id)
);

create table competitor_metrics (
  competitor_id uuid primary key references competitors(id) on delete cascade,
  ors numeric(5, 4),
  official_assets int,
  thirdparty_assets int,
  diversity int,
  recency_60d int,
  nonbrand_exposure int,
  channel_activity numeric(5, 2),
  raw jsonb not null default '{}'::jsonb
);

-- ─────────────────────────────────────────────────────────── 점수 (F-21 3축)
create table scores (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  attempt_id uuid not null,
  company_id uuid not null references companies(id) on delete cascade,
  axis_problem numeric(5, 2) not null check (axis_problem >= 0),
  axis_propensity numeric(5, 2) not null check (axis_propensity >= 0),
  axis_confidence numeric(5, 2) not null check (axis_confidence >= 0),
  total numeric(5, 2) not null check (total >= 0),
  breakdown jsonb not null,
  weaknesses jsonb not null,
  competitor_gap_available boolean not null default false,
  -- R2-02: ORS 배점이 실제로 반영됐는지. 서면 허용 + Phase 4 검증 전에는 false.
  ors_scored boolean not null default false,
  rule_version text not null,
  gate_passed boolean not null,
  gate_reason text,
  invalidated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (attempt_id, company_id),
  -- R2-22: review_items 가 단일 복합 FK 로 결속할 대상
  unique (id, attempt_id, company_id),
  -- attempt 가 실제로 그 run 소속인지 DB 가 보장한다
  foreign key (attempt_id, run_id) references run_attempts (id, run_id) on delete cascade
);

-- R2-23: 점수가 참조한 관측 버전을 고정한다. observation_id 하나로는 재현되지 않는다.
create table score_inputs (
  score_id uuid not null references scores(id) on delete cascade,
  input_kind text not null
    check (input_kind in ('company_obs', 'website_obs', 'channel_obs', 'search_agg', 'competitor')),
  input_id text not null,
  primary key (score_id, input_kind, input_id)
);

create table recommendations (
  score_id uuid primary key references scores(id) on delete cascade,
  primary_service text not null,
  secondary_services text[] not null default '{}',
  rationale text,
  rationale_source text not null default 'rule' check (rationale_source in ('rule', 'llm'))
);

-- ─────────────────────────────────────────────────────────── 검수
create table review_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  attempt_id uuid not null,
  company_id uuid not null references companies(id) on delete cascade,
  score_id uuid not null,
  rank int not null,
  status review_status not null default 'pending',
  decided_by uuid references profiles(id),
  decided_at timestamptz,
  reject_reason text,
  note text,
  created_at timestamptz not null default now(),
  unique (attempt_id, company_id),
  -- R2-22: score_id 와 attempt/company 를 **하나의** 복합 FK 로 결속.
  --        (v2 는 두 FK 가 독립이라 서로 다른 score 를 조합할 수 있었다)
  foreign key (score_id, attempt_id, company_id)
    references scores (id, attempt_id, company_id) on delete cascade,
  foreign key (attempt_id, run_id) references run_attempts (id, run_id) on delete cascade
);
-- 같은 run 안에서 한 업체가 두 attempt 에 걸쳐 동시에 pending 이 되지 않게 한다
create unique index review_items_one_open_per_run
  on review_items (run_id, company_id) where status = 'pending';

-- R2-18: 승인 상한은 run 이 아니라 **승인일** 기준이어야 수동 run 추가로 우회되지 않는다.
-- 일 총량과 업종별 카운터를 분리한다. 업종 행만 잠그면 서로 다른 업종의 동시 승인이
-- 같은 총합을 읽고 함께 통과해 상한을 넘긴다.
create table approval_day_totals (
  approval_date date primary key,
  approved_total int not null default 0 check (approved_total >= 0)
);
create table approval_counters (
  approval_date date not null references approval_day_totals(approval_date) on delete cascade,
  industry text not null,
  approved_count int not null default 0 check (approved_count >= 0),
  primary key (approval_date, industry)
);

-- ❗ 수동 입력 rate limit 은 **추가 전용 이벤트**로 센다.
--    `emails.entered_at` 행 수를 세면 두 가지가 틀린다:
--      1. 같은 주소를 재입력하면 UPDATE 라 행 수가 늘지 않아 과소 계산된다.
--      2. 다른 적재 경로가 entered_by 를 쓰면 과대 계산된다.
create table manual_entry_events (
  id bigserial primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  review_item_id uuid not null,
  created_at timestamptz not null default now()
);
create index manual_entry_events_rate on manual_entry_events (user_id, created_at desc);

-- R2-08: 검수 화면을 실제로 연 세션만 이메일을 입력할 수 있게 하는 1회용 nonce
create table review_view_nonces (
  nonce text primary key,
  review_item_id uuid not null references review_items(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index review_view_nonces_gc on review_view_nonces (expires_at);

create table leads (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id),
  company_id uuid not null references companies(id),
  review_item_id uuid not null references review_items(id) on delete cascade,
  email_id uuid not null references emails(id),
  score numeric(5, 2) not null,
  snapshot jsonb not null,
  -- ❗ 승인 시점의 카운터 좌표를 **고정**한다.
  --    취소(revoke_approval)가 current_date·현재 업종으로 다시 계산하면,
  --    업체 업종이 바뀌었거나 세션 시간대가 다를 때 엉뚱한 카운터를 감소시킨다.
  approval_date date not null,
  approved_industry text not null,
  -- R2-03: 접촉 근거는 수집 근거와 별개다. 기본값은 판단 보류.
  contact_legal_basis contact_basis not null default 'pending_legal_review',
  contact_basis_set_by uuid references profiles(id),
  contact_basis_note text,
  -- R2-32: 대외 반출 통제. MVP 는 내부 분석 전용.
  use_scope text not null default 'internal_only'
    check (use_scope in ('internal_only', 'external_proposal')),
  retention_until date not null,
  export_status text not null default 'none' check (export_status in ('none', 'exported')),
  external_crm_id text,
  exported_at timestamptz,
  export_count int not null default 0,
  created_at timestamptz not null default now(),
  -- F-06: 영구 차단이 아니라 run 단위. 과거 승인 업체의 재진입을 막지 않는다.
  unique (company_id, run_id)
);

-- ─────────────────────────────────────────────────────────── 개인정보 (R2-26)
create table privacy_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('access', 'delete', 'suspend', 'correct')),
  subject_identifier text not null,
  company_id uuid references companies(id) on delete set null,
  status text not null default 'received'
    check (status in ('received', 'in_progress', 'on_hold', 'completed', 'rejected')),
  hold_reason text,
  legal_hold boolean not null default false,
  received_at timestamptz not null default now(),
  due_at timestamptz not null,
  completed_at timestamptz,
  completed_by uuid references profiles(id),
  actions_taken jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '{}'::jsonb
);
create index privacy_requests_open on privacy_requests (company_id)
  where status in ('received', 'in_progress', 'on_hold');

-- ─────────────────────────────────────────────────────────── 운영
create table settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now()
);

create table cost_ledger (
  id bigserial primary key,
  run_id uuid references runs(id) on delete cascade,
  -- F-16: 재시도 시 비용이 중복 적재되지 않게 하는 멱등 키
  entry_key text not null unique,
  provider text not null,
  unit text not null,
  qty numeric(12, 2) not null,
  krw numeric(10, 2) not null default 0,
  created_at timestamptz not null default now()
);

create table http_cache (
  cache_key text primary key,
  status int,
  headers jsonb,
  body_hash text,
  -- 최대 4KB 발췌만. HTML 원문은 저장하지 않는다 (R9 용량).
  body_excerpt text check (body_excerpt is null or octet_length(body_excerpt) <= 4096),
  fetched_at timestamptz not null,
  expires_at timestamptz not null
);
create index http_cache_expiry on http_cache (expires_at);

create table outbox (
  id bigserial primary key,
  -- F-16: 이벤트 중복 발행 방지
  event_key text not null unique,
  topic text not null,
  payload jsonb not null,
  published_at timestamptz,
  created_at timestamptz not null default now()
);

create table audit_log (
  id bigserial primary key,
  actor uuid references profiles(id),
  action text not null,
  entity text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  ip inet,
  created_at timestamptz not null default now()
);
create index audit_log_recent on audit_log (created_at desc);
