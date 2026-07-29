# leadops UI·UX 전면 구축 계획 — The Verge 디자인 시스템 재해석

> 작성일 2026-07-29 · 브랜치 `feature/design-setup`
> 근거 문서: `DESIGN-theverge.md`(비주얼 레퍼런스) · `../docs/00-plan.md`(설계서 v3, 비즈니스 로직의 유일한 권위)

## 0. 전제 확인 — "전면 개선"의 실제 의미

상위 leadops 모노레포는 **Phase -1(기반 구현) 상태로, 검수 UI·DB·워커가 아직 존재하지 않는다**
(README 명시). 따라서 이 작업은 기존 화면의 리스킨이 아니라 **설계서 v3 §8(화면 구조)을 스펙으로
삼아 프론트엔드를 신규 구축**하는 것이다. `taimen` 저장소가 그 구축 위치다.

데이터 연결에 대해: 설계서 §7.2의 HTTP API는 아직 서버 구현이 없다. 그러므로
"실데이터 연결을 mock으로 대체"하는 것이 아니라, **§7.2 계약에 맞춘 타입드 데이터 계층을
만들고 fixture 소스를 명시적 개발 모드로 제공**한다. 이는 모노레포 자체의 컨벤션
(`FEATURE_SOURCE=mock`이 1급 개발 경로, production에서는 부팅 거부)을 따르는 것이다.
API 서버가 생기면 데이터 소스 구현체 1개만 교체하면 된다. **이 문서와 최종 보고에서
"실데이터 연동 완료"를 주장하지 않는다.**

## 1. 첨부 디자인 문서 이해

DESIGN-theverge.md의 본질은 세 가지다.

1. **색-으로-위계 (color-as-elevation)**: 그림자·그라데이션·blur 전면 금지. `#131313` 캔버스 위에서
   1px 헤어라인 테두리와 채도 높은 단색 블록만으로 깊이를 만든다. 민트 `#3cffd0`와
   울트라바이올렛 `#5200ff`는 "hazard tape" — 화면에서 가장 중요한 것에만 소량 사용.
2. **속삭임 대 외침 타이포그래피**: 60~107px 디스플레이(Manuka)의 "외침"과 11~12px 모노
   대문자 라벨(1.1~1.9px 자간)의 "속삭임"이 만드는 대비가 목소리의 전부. 중간 크기는 워크호스
   산세리프가 조용히 처리한다.
3. **타임라인 리듬 (StoryStream)**: 왼쪽 세로 레일 + 모노 타임스탬프 + 둥근(20px) 이벤트 블록의
   스택. 중요한 항목만 컬러 블록으로 리듬을 깬다.

## 2. 유지할 디자인 DNA

- `#131313` 단일 다크 캔버스, 라이트 모드 없음
- 민트/울트라바이올렛의 절제된 hazard 액센트 (버튼·1px 테두리·활성 상태·핵심 KPI 1개)
- 그림자 0 — 1px 테두리(`#2d2d2d` 기본, 흰색·민트·보라는 강조 전용)와 단색 블록으로 위계
- pill 버튼(24px+), 둥근 카드(20px), 2px 인풋 — "타자기 태그 vs pill" 대비 라디우스 스케일
- 모노 대문자 라벨 + 1.2~1.8px 자간 (섹션 라벨·타임스탬프·상태·점수·실행 ID 전용)
- 디스플레이 폰트는 워드마크와 대형 숫자에만 (Anton — 대체 폰트 규정에 따라 line-height 0.95)
- 링크 호버 `#3860be` 단일 규칙, 포커스 링 `#1eaedb` 키보드 전용
- 타임라인 레일 구조 → `SignalStream`으로 재해석

## 3. leadops에 그대로 적용하면 안 되는 요소

| The Verge | 이유 | leadops 대체 |
|---|---|---|
| 채도 높은 스토리 타일(노랑·핑크·오렌지 등 6색) | 하루 100건 검수 시 시각 피로·상태 혼동 | 액센트는 민트·보라 2색으로 한정, 컬러 블록은 화면당 1~2개 |
| 107px 헤드라인을 피드 전체에 반복 | 데이터 밀도 파괴 | 디스플레이는 워드마크·KPI 대형 숫자에만 |
| 카드 그리드 피드 | 검수는 스캔 속도가 생명 — 테이블이어야 함 | 1px 행 구분 밀도 테이블, 호버는 배경 미세 변화만 |
| 전 카드 1px 흰색 테두리 | 100행 테이블에서 시끄러움 | 기본 라인은 `#2d2d2d`, 흰색·민트 라인은 강조 전용 |
| 에디토리얼 자유 그리드(타일이 2~3컬럼 임의 스팬) | 반복 작업 도구는 예측 가능성이 우선 | 고정 사이드바 + 고정 테이블 + 고정 드로어 |
| "검색 노출·순위·점유율" 류 카피 | **설계서 결론 C가 UI에서 해당 표현을 금지** | "콘텐츠 회수 점유(ORS)" · "네이버 Open API 기준 콘텐츠 회수량"으로 표기 |

## 4. 현재 UI의 문제점

현재 UI는 존재하지 않는다. 설계서 §8.1의 지시("흑백 + 강조색 1, 카드·그래디언트·애니메이션 없음")는
기능적으로 옳지만 그대로 만들면 "평범한 관리자 페이지"가 된다 — 이번 요청이 금지한 결과물.
따라서 §8의 **정보 구조·키보드 흐름·법적 제약(이메일 수동 입력, MX 게이트, 일괄 제외만)은 전부
보존**하되, 시각 언어만 The Verge DNA의 절제된 재해석으로 교체한다.

## 5. 디자인 토큰 (CSS variables + Tailwind v4 @theme)

```css
--canvas: #131313;        /* 기본 캔버스 */
--surface: #2d2d2d;       /* 2차 표면 (secondary 버튼, 호버) */
--surface-subtle: #1b1b1b;/* 테이블 헤더·드로어 섹션 배경 */
--accent: #3cffd0;        /* 민트 — primary CTA, 활성 상태, 핵심 KPI */
--accent-dim: #309875;    /* 민트 테두리 절제 변형 */
--violet: #5200ff;        /* 보라 — 보조 강조, 에러 액센트 */
--violet-rule: #3d00bf;   /* SignalStream 레일 */
--text: #ffffff;  --text-2: #949494;  --text-3: #e9e9e9;
--ink: #131313;           /* 민트/흰 블록 위 텍스트 */
--line: #2d2d2d;  --line-strong: rgba(255,255,255,.25);
--link-hover: #3860be;  --focus: #1eaedb;
/* radius: 2px 인풋 · 8px 셀 내부 요소 없음 · 12px 스트림 블록 · 20px 카드·태그 pill · 24px 버튼 pill */
/* fonts: Pretendard Variable(한글·UI) · Anton(디스플레이, lh 0.95) · JetBrains Mono(대문자 라벨) */
```

폰트는 전부 무료·셀프호스팅: `pretendard`, `@fontsource/anton`, `@fontsource-variable/jetbrains-mono`
npm 패키지. 외부 CDN 요청 없음.

## 6. 화면별 개선안

- **Scout `/today` (기본 진입)** — 상단 MetricStrip: 수집 후보→상세 분석→검수 대기→승인→제외→최종
  리드 6개 수치를 한 줄 스트립으로. **"검수 대기"만 민트 블록**(오늘의 작업량이 가장 중요한 수치),
  나머지는 캔버스 위 대형 숫자 + 모노 라벨. 승인 수치에는 `승인/상한(50)` 표기.
  테이블 컬럼: 업체명 / 업종 / 지역 / 이메일 / 리드 점수(3축 미니 분해) / 핵심 취약점 /
  주력 추천 서비스 / 신뢰도 / 승인 / 제외. 행 클릭 → 드로어. 키보드 `j`/`k` 이동, `x` 제외,
  `Space` 선택, `e` 이메일 폼 포커스(설계서 §8.2 그대로). **일괄 처리는 제외만** — 승인은 이메일
  MX 통과가 필요하므로 개별만 가능, 이메일 미입력 행의 승인 버튼은 비활성.
- **리드 상세 드로어** — 요청된 10개 섹션 순서 고정. 작은 카드 중첩 없이 `01 COMPANY`…`10 DECISION`
  모노 라벨 + 1px 구분선. 총점은 Anton 대형 숫자 + 3축(문제 0~60 / 구매 0~25 / 신뢰 0~15) 게이지.
  검색 점유 공백은 `SearchGapPanel`(채널별 ORS 막대 — blog·cafe·web·news, local은 "플레이스 등록"
  boolean), 경쟁사 3곳은 `CompetitorComparison` 미니 테이블. 이메일 섹션은 연락처 페이지 후보
  목록(신뢰도·새 탭 링크) + 수동 입력 폼 + **정보통신망법 제50조의2 고지 문구** + 문법→DNS→MX
  검증 상태 표시. MX 미통과 시 승인 버튼 비활성 유지.
- **SignalStream** — 좌측 세로 레일(1px `#3d00bf`), 모노 타임스탬프, 12px 라디우스 이벤트 블록.
  기본 블록은 `#1b1b1b` + `#2d2d2d` 테두리, 중요 이벤트만 민트(성공·승인)/보라(실패·경고) 블록.
  적용: 드로어의 검색 결과물·최근 활동, `/runs` 스테이지 진행, 향후 발송·회신·파이프라인 이력.
- **승인 리드 `/leads`** — 절제된 테이블 + `READY SENT OPENED REPLIED MEETING PROPOSAL WON LOST`
  모노 pill(READY·WON만 민트 계열, LOST는 보라 계열, 나머지는 무채색). 승인일·업종·점수 필터,
  export 버튼(워터마크·횟수 제한 문구).
- **`/runs`** — 실행 목록(모노 실행 ID·비용·쿼터) + 선택 실행의 13개 스테이지 SignalStream +
  실패 잡 테이블(에러·시도 횟수).
- **`/industries`** — 업종 4종(피부과·성형외과·치과·프랜차이즈) + 키워드 템플릿, LLM 초안
  `approved=false` 승인 플로우.
- **`/settings`** — 절제 다크 폼. 목표치·3축 가중치·쿼터·비용 상한 그룹.
- **Outreach / Pipeline / Insights** — EmptyState(모듈 로드맵 명시)로 확장 지점만 예약.

## 7. 생성할 컴포넌트

`AppShell` `Sidebar` `ContextHeader` `MetricStrip` `LeadTable` `LeadScore` `StatusTag`
`FilterBar` `DetailDrawer` `SignalStream` `SearchGapPanel` `CompetitorComparison`
`EmptyState` `LoadingState` `ErrorState` `Button`(pill primary/secondary/outline)
`MonoLabel`(섹션 라벨) — 전부 신규.

## 8. 파일 단위 작업 계획

```
taimen/
├ package.json · next.config.ts · tsconfig.json · postcss.config.mjs · .gitignore
├ src/app/globals.css            # 토큰·@theme·베이스 (1단계)
├ src/app/layout.tsx             # 폰트 로드 + AppShell (2단계)
├ src/app/page.tsx               # → /today 리다이렉트
├ src/app/{today,leads,outreach,pipeline,insights,industries,runs,settings}/page.tsx
├ src/components/shell/  AppShell.tsx Sidebar.tsx ContextHeader.tsx
├ src/components/ui/     Button.tsx StatusTag.tsx LeadScore.tsx MonoLabel.tsx
│                        EmptyState.tsx LoadingState.tsx ErrorState.tsx
├ src/components/today/  MetricStrip.tsx FilterBar.tsx LeadTable.tsx
├ src/components/drawer/ DetailDrawer.tsx SearchGapPanel.tsx CompetitorComparison.tsx
│                        EmailEntry.tsx
├ src/components/stream/ SignalStream.tsx
└ src/lib/data/          types.ts fixtures.ts store.tsx   # §7.2 계약 반영 데이터 계층
```

구현 순서: 토큰 → 앱 셸 → 오늘의 검수 → 리드 상세 → 승인 리드 → SignalStream(드로어·runs에서
사용되므로 실제로는 4단계와 병행) → 업종 → 실행 이력 → 설정 → 반응형·접근성 → QA.

## 9. 기능 손상 위험과 방지책

| 위험 | 방지책 |
|---|---|
| 이메일 자동 수집처럼 보이는 UI | 이메일 컬럼·폼에 "수동 입력" 상태를 명시, 법 고지 문구 상시 노출 |
| MX 미검증 승인 | 이메일 검증 상태가 `mx_ok`가 아니면 승인 버튼 비활성 (테이블·드로어 동일 규칙) |
| 일괄 승인 허용 실수 | 일괄 액션은 "선택 제외"만 렌더링 |
| ORS 과장 카피 | "점유율/순위/노출" 단어를 UI 문자열에서 배제, "콘텐츠 회수 점유(ORS)" 사용 |
| fixture를 실데이터로 오인 | 데이터 계층에 소스 모드 상수 명시 + 본 문서·최종 보고에 미연동 사실 기록 |
| 업종 60%·일 50건 상한 로직 누락 | MetricStrip에 상한 대비 표기, 승인 시 카운터 반영 |

## 10. 완료 기준

1. `pnpm build`(Next production build) 및 typecheck 통과
2. 8개 라우트 + 드로어가 전부 동작하고 키보드 흐름(j/k/x/Space/e)이 작동
3. 그림자·그라데이션·glassmorphism 0건 (코드 감사)
4. 디스플레이 폰트가 워드마크·대형 숫자 외에 사용된 곳 0건, 소문자 모노 0건
5. 민트/보라가 배경 워시로 쓰인 곳 0건 — 액센트는 상태·중요도 표현에만
6. 검수 테이블이 1440px에서 스크롤 없이 10컬럼 표시, 행 높이 ≤ 44px (하루 100건 검수 밀도)
7. 승인 게이트(이메일·MX)·일괄 제외 제한·법 고지 등 설계서 비즈니스 규칙이 UI에 반영
8. Outreach/Pipeline/Insights 확장 지점과 8개 리드 상태가 디자인 시스템 안에 예약됨
