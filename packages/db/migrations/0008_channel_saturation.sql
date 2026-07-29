-- Phase 4 — 채널 관측의 데이터 품질 표시
--
-- RSS·Atom 피드는 최근 N건만 준다 (유튜브 공개 피드는 15건 고정). 그래서 발행이 잦은
-- 채널은 피드가 120일 창을 덮지 못하고, `posts_120d` 가 실제값이 아니라 **하한**이 된다.
--
-- 이 사실을 남기지 않으면 Phase 5 점수 로직이 하한값을 실제값으로 다루게 된다.
-- "활동 부족" 축 판정만 놓고 보면 하한이어도 결론이 뒤집히지 않지만(하한이 이미 크면
-- 활발한 것이 확실하다), 관측치가 무엇인지 모르는 채로 쓰는 것과 알고 쓰는 것은 다르다.

alter table channel_observations
  add column feed_saturated boolean not null default false;

comment on column channel_observations.feed_saturated is
  '피드가 120일 창을 덮지 못했다. posts_60d·posts_120d 는 하한값이다.';

-- ── ORS 분모가 0 인 경우를 기록할 수 있게 한다 ──
--
-- 원래 제약은 `denominator > 0` 이었다. 그러면 "그 키워드로는 채널 전체에 결과가
-- 한 건도 없다" 를 저장할 수 없다. 그런데 그것은 버릴 정보가 아니다 —
-- **아무도 콘텐츠가 없는 키워드는 점유 공백을 재는 데 쓸 수 없다**는 뜻이고,
-- "측정했더니 0" 과 "측정하지 않음" 은 반드시 구분돼야 한다.
--
-- denominator = 0 이면 ORS 는 0 이 아니라 **정의되지 않음**(null)이다.

alter table search_aggregates drop constraint if exists search_aggregates_denominator_check;
alter table search_aggregates
  add constraint search_aggregates_denominator_nonneg check (denominator >= 0);

comment on column search_aggregates.denominator is
  'min(30, total_returned). 0 이면 그 키워드로 채널에 결과가 없다는 뜻이고 ors 는 null 이다.';
