import { readFileSync } from "node:fs";
import { INDUSTRY_LABEL, type Industry, type Logger } from "@leadops/core";
import postgres, { type Sql } from "postgres";
import { renderTable } from "./cli";
import { GOLDSET_HEADER } from "./sample";
import { ci, pct, spearman, wilson, type Correlation, type Proportion } from "./stats";

/**
 * 골드셋 측정 (설계서 9.1 — Phase 0 탐색적 검증).
 *
 * 입력이 **둘**이다:
 *   1. 사람이 라벨링한 골드셋 CSV  (진실값)
 *   2. 파이프라인이 실제로 낸 판정 (DB)
 *
 * ❗ 여기서 판정을 **다시 계산하지 않는다.** 우리 알고리즘을 우리가 재구현해 비교하면
 *    구현 두 개를 비교하는 것이고, 운영에서 도는 코드를 검증한 것이 아니다. DB 에 남은
 *    실제 출력을 읽는다 — 그래서 측정 전에 그 표본으로 파이프라인이 돌아 있어야 한다.
 *
 * ❗ **라벨이 없는 지표는 숫자를 만들지 않는다.** 비어 있는 라벨을 `no` 로 읽으면 정밀도가
 *    올라가고 재현율이 내려간다 — 즉 라벨링을 덜 한 것이 성적으로 바뀐다. 미측정은 미측정이다.
 *
 * ❗ 판정은 `stop` 또는 `inconclusive` **둘뿐**이다 (설계서 R2-06). `go` 는 없다.
 *    게이트 입력(M3b·M7)이 없으면 `inconclusive` 도 낼 수 없다 — `미판정` 이다.
 */

// ─────────────────────────────────────────────────────────── CSV 파싱

/** RFC 4180 최소 파서. 따옴표 안의 구분자·줄바꿈·이중 따옴표를 처리한다. */
export function parseCsv(text: string): string[][] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // BOM 제거
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export interface GoldsetRow {
  industry: string;
  source: string;
  externalId: string;
  name: string;
  homepageUrlHint: string;
  labelOfficialUrl: string;
  labelOfficialStatus: string;
  labelHasBusinessEmail: string;
  labelEmailLocation: string;
  labelEmailIsFreeMail: string;
  labelPerceivedExposure: string;
  labelCompetitorValidity: string;
  labelWorthPitching: string;
  labelRenderMode: string;
}

const COLUMN_OF: Record<keyof GoldsetRow, string> = {
  industry: "industry",
  source: "source",
  externalId: "external_id",
  name: "name",
  homepageUrlHint: "homepage_url_hint",
  labelOfficialUrl: "label_official_url",
  labelOfficialStatus: "label_official_status",
  labelHasBusinessEmail: "label_has_business_email",
  labelEmailLocation: "label_email_location",
  labelEmailIsFreeMail: "label_email_is_free_mail",
  labelPerceivedExposure: "label_perceived_exposure",
  labelCompetitorValidity: "label_competitor_validity",
  labelWorthPitching: "label_worth_pitching",
  labelRenderMode: "label_render_mode",
};

/**
 * 라벨 CSV 를 읽는다.
 *
 * ❗ 헤더를 **이름으로** 찾는다. 위치로 읽으면 라벨러가 엑셀에서 열을 옮기거나 메모 열을
 *    추가한 순간 다른 값을 다른 지표로 세게 된다 — 조용히 틀린 숫자가 나온다.
 */
export function readGoldset(path: string): GoldsetRow[] {
  const rows = parseCsv(readFileSync(path, "utf8"));
  const header = rows[0];
  if (!header) throw new Error(`빈 CSV 입니다: ${path}`);

  const index = new Map(header.map((h, i) => [h.trim(), i]));
  const missing = Object.values(COLUMN_OF).filter((c) => !index.has(c));
  if (missing.length > 0) {
    throw new Error(
      `CSV 에 필요한 열이 없습니다: ${missing.join(", ")}\n` +
        `  기대 헤더: ${GOLDSET_HEADER.join(", ")}\n` +
        `  'pnpm spike sample' 이 만든 CSV 를 쓰세요 (열 이름을 바꾸지 마세요).`,
    );
  }

  const at = (row: string[], key: keyof GoldsetRow): string =>
    (row[index.get(COLUMN_OF[key])!] ?? "").trim();

  const out: GoldsetRow[] = [];
  for (const row of rows.slice(1)) {
    // 엑셀이 남기는 빈 줄을 건너뛴다.
    if (row.every((c) => c.trim() === "")) continue;
    out.push({
      industry: at(row, "industry"),
      source: at(row, "source"),
      externalId: at(row, "externalId"),
      name: at(row, "name"),
      homepageUrlHint: at(row, "homepageUrlHint"),
      labelOfficialUrl: at(row, "labelOfficialUrl"),
      labelOfficialStatus: at(row, "labelOfficialStatus").toLowerCase(),
      labelHasBusinessEmail: at(row, "labelHasBusinessEmail").toLowerCase(),
      labelEmailLocation: at(row, "labelEmailLocation"),
      labelEmailIsFreeMail: at(row, "labelEmailIsFreeMail").toLowerCase(),
      labelPerceivedExposure: at(row, "labelPerceivedExposure"),
      labelCompetitorValidity: at(row, "labelCompetitorValidity"),
      labelWorthPitching: at(row, "labelWorthPitching").toLowerCase(),
      labelRenderMode: at(row, "labelRenderMode").toLowerCase(),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────── 라벨 해석

const yesNo = (raw: string): boolean | null => (raw === "yes" ? true : raw === "no" ? false : null);

const likert = (raw: string): number | null => {
  if (!/^[1-5]$/.test(raw)) return null;
  return Number(raw);
};

/** 사람이 "공식 홈페이지가 있다" 고 판정했나. `none` 은 없다는 판정이고, 빈값은 미라벨이다. */
const labelledOfficial = (row: GoldsetRow): boolean | null =>
  row.labelOfficialStatus === "official"
    ? true
    : row.labelOfficialStatus === "not_official" || row.labelOfficialStatus === "none"
      ? false
      : null;

// ─────────────────────────────────────────────────── 시스템 측 출력 (DB)

/**
 * 표본 ↔ 파이프라인 출력 조인 키.
 *
 * ❗ **한 곳에서만 만든다.** 이 키를 세 곳(질의·맵 적재·지표 계산)에서 각자 조립했을 때
 *    구분자가 어긋나 조회가 전부 실패했고, 그 결과는 에러가 아니라 **"매칭된 표본이 없습니다"**
 *    라는 그럴듯한 미측정 보고였다. 조용히 틀리는 종류의 결함이라 함수로 묶는다.
 * ❗ 키를 **JSON 배열로** 인코딩한다. 구분자 문자를 쓰지 않으므로 어떤 값이 들어와도
 *    모호해지지 않고, 소스에 보이지 않는 제어문자가 남지 않는다 — 이번 결함이 그것이었다.
 */
export const verdictKey = (source: string, externalId: string): string =>
  JSON.stringify([source, externalId]);

export interface SystemVerdict {
  /**
   * 우리가 **평가할 홈페이지 URL 을 확보했나** (M1).
   *
   * ❗ 판정 결과가 아니라 **입력을 가졌는가**다. HIRA 의 `hospUrl` 은 실측 19% 만 채워져
   *    있어서(표본 90건), URL 이 없으면 `homepage_detect` 는 판정 자체를 하지 못한다.
   *    M1 의 미달 대응이 "소스 보강" 인 이유가 이것이다.
   */
  hasWebsite: boolean;
  /** 우리가 공식(confirmed·likely)으로 판정했나. 관측이 없으면 null (판정 못 함). */
  officialJudged: boolean | null;
  /** 우리가 제안한 연락처 페이지 경로들. */
  contactPaths: string[];
  /** ORS 를 산출했나 (분모 > 0 인 집계가 있나). */
  orsComputed: boolean;
  /** 유효 경쟁사 수. */
  validCompetitors: number;
  /** 우리가 최종 검수 후보로 올렸나. */
  shortlisted: boolean;
}

/**
 * 표본 업체들의 파이프라인 출력을 읽는다.
 *
 * `raw_candidates(source, external_id)` → `company_id` 로 잇는다. 이 표본으로 파이프라인이
 * 돌지 않았으면 매칭이 0 이고, 그 사실을 **에러로** 알린다 — 0 건을 "전부 실패" 로
 * 보고하면 파이프라인을 안 돌린 것이 성적으로 바뀐다.
 */
export async function loadSystemVerdicts(
  sql: Sql,
  rows: readonly GoldsetRow[],
): Promise<Map<string, SystemVerdict>> {
  const sources = rows.map((r) => r.source);
  const externalIds = rows.map((r) => r.externalId);

  const found = await sql<Array<{
    source: string;
    external_id: string;
    has_website: boolean;
    official_judged: boolean | null;
    contact_paths: string[] | null;
    ors_computed: boolean;
    valid_competitors: number;
    shortlisted: boolean;
  }>>`
    with sampled as (
      select distinct rc.source, rc.external_id, rc.company_id
      from raw_candidates rc
      where (rc.source, rc.external_id) in (
        select * from unnest(${sources}::text[], ${externalIds}::text[])
      )
        and rc.company_id is not null
    )
    select s.source, s.external_id,
           -- M1: 평가할 URL 을 확보했나. 판정 결과가 아니라 입력 유무다.
           exists (select 1 from websites w where w.company_id = s.company_id) as has_website,
           -- 공식 판정: 가장 최근 관측 기준. 관측이 없으면 null (판정하지 못했다).
           (select o.official_status in ('confirmed', 'likely')
              from websites w
              join website_observations o on o.website_id = w.id
             where w.company_id = s.company_id
             order by o.observed_at desc limit 1) as official_judged,
           (select array_agg(distinct cp.url)
              from websites w join contact_pages cp on cp.website_id = w.id
             where w.company_id = s.company_id) as contact_paths,
           exists (select 1 from search_aggregates sa
                    where sa.company_id = s.company_id and sa.denominator > 0) as ors_computed,
           (select count(*)::int from competitors c
             where c.company_id = s.company_id and c.is_valid) as valid_competitors,
           exists (select 1 from review_items ri where ri.company_id = s.company_id) as shortlisted
    from sampled s
  `;

  const map = new Map<string, SystemVerdict>();
  for (const row of found) {
    map.set(verdictKey(row.source, row.external_id), {
      hasWebsite: row.has_website,
      officialJudged: row.official_judged,
      contactPaths: row.contact_paths ?? [],
      orsComputed: row.ors_computed,
      validCompetitors: row.valid_competitors,
      shortlisted: row.shortlisted,
    });
  }
  return map;
}

// ─────────────────────────────────────────────────────────── 지표

export interface Metric {
  id: string;
  label: string;
  /** 통과 기준 설명. 기준이 없는 실측 지표는 undefined. */
  threshold?: string;
  proportion?: Proportion;
  correlation?: Correlation;
  mean?: { value: number | null; n: number };
  /** 측정하지 못한 이유. 있으면 숫자를 신뢰하지 않는다. */
  unmeasured?: string;
}

export type Verdict = "stop" | "inconclusive" | "미판정";

export interface MeasureReport {
  measuredAt: string;
  goldsetPath: string;
  total: number;
  matched: number;
  labelled: Record<string, number>;
  metrics: Metric[];
  verdict: Verdict;
  verdictReasons: string[];
  perIndustry: Array<{ industry: string; n: number; m9: Proportion }>;
}

/** 라벨이 하나도 없으면 지표가 아니라 미측정이다. */
const unmeasured = (id: string, label: string, why: string, threshold?: string): Metric => ({
  id,
  label,
  ...(threshold === undefined ? {} : { threshold }),
  unmeasured: why,
});

export function computeMetrics(
  rows: readonly GoldsetRow[],
  verdicts: Map<string, SystemVerdict>,
): { metrics: Metric[]; labelled: Record<string, number> } {
  const key = (r: GoldsetRow): string => verdictKey(r.source, r.externalId);
  const sys = (r: GoldsetRow): SystemVerdict | undefined => verdicts.get(key(r));

  const metrics: Metric[] = [];
  const labelled: Record<string, number> = {};

  // ── M1 홈페이지 발견률 ──
  //
  // ❗ **우리의 발견률**이다 (사람이 찾은 비율이 아니다). 미달 시 대응이 "소스 보강"
  //    (설계서 9.1)인 이유가 이것이다 — 사람이 찾은 비율은 우리가 소스를 보강해도
  //    바뀌지 않는 모집단 특성이므로, 그 값으로는 "소스를 보강해야 한다" 를 판단할 수 없다.
  //    분모는 표본 전체다: URL 이 없어 판정조차 못 한 업체가 빠지면 발견률의 의미가 사라진다.
  const matched = rows.filter((r) => sys(r) !== undefined);
  metrics.push(
    matched.length === 0
      ? unmeasured("M1", "홈페이지 발견률 (우리)", "매칭된 표본이 없습니다 (파이프라인 미실행?)", "≥ 70%")
      : {
          id: "M1",
          label: "홈페이지 발견률 (우리)",
          threshold: "≥ 70%",
          proportion: wilson(matched.filter((r) => sys(r)!.hasWebsite).length, matched.length),
        },
  );

  // ── M1-상한 (실측) ── 사람이 확인한 **실제 존재율**. 우리 발견률의 천장이다.
  const m1Rows = rows.filter((r) => labelledOfficial(r) !== null);
  labelled["official_status"] = m1Rows.length;
  metrics.push(
    m1Rows.length === 0
      ? unmeasured("M1-상한", "실제 홈페이지 존재율 (사람)", "label_official_status 가 비어 있습니다")
      : {
          id: "M1-상한",
          label: "실제 홈페이지 존재율 (사람)",
          proportion: wilson(m1Rows.filter((r) => labelledOfficial(r) === true).length, m1Rows.length),
        },
  );

  // ── M2 공식 판별 정밀도 / 재현율 ──
  //
  // ❗ 우리 판정이 null(관측 실패)인 행은 **분모에서 뺀다.** "판정하지 못했다" 를 "아니라고
  //    판정했다" 로 세면 재현율이 우리 수집 실패만큼 낮아지고, 정밀도는 부당하게 높아진다.
  const m2Rows = m1Rows.filter((r) => sys(r)?.officialJudged !== undefined && sys(r)?.officialJudged !== null);
  const tp = m2Rows.filter((r) => sys(r)!.officialJudged === true && labelledOfficial(r) === true).length;
  const fp = m2Rows.filter((r) => sys(r)!.officialJudged === true && labelledOfficial(r) === false).length;
  const fn = m2Rows.filter((r) => sys(r)!.officialJudged === false && labelledOfficial(r) === true).length;

  if (m2Rows.length === 0) {
    metrics.push(unmeasured("M2-정밀도", "공식 판별 정밀도", "판정된 표본이 없습니다 (파이프라인 미실행?)", "≥ 0.90"));
    metrics.push(unmeasured("M2-재현율", "공식 판별 재현율", "판정된 표본이 없습니다", "≥ 0.75"));
  } else {
    metrics.push({
      id: "M2-정밀도",
      label: "공식 판별 정밀도",
      threshold: "≥ 0.90",
      proportion: wilson(tp, tp + fp),
    });
    metrics.push({
      id: "M2-재현율",
      label: "공식 판별 재현율",
      threshold: "≥ 0.75",
      proportion: wilson(tp, tp + fn),
    });
  }

  // ── M3 연락처 페이지 후보 적중률 ──
  //
  // 우리가 후보를 제안한 업체 중, 사람이 **그 후보 중 하나에서** 이메일을 찾은 비율.
  const m3Rows = rows.filter((r) => {
    const v = sys(r);
    return v !== undefined && v.contactPaths.length > 0 && r.labelEmailLocation !== "";
  });
  labelled["email_location"] = rows.filter((r) => r.labelEmailLocation !== "").length;
  const pathOf = (url: string): string => {
    try {
      return new URL(url).pathname.replace(/\/+$/, "") || "/";
    } catch {
      return url.replace(/\/+$/, "");
    }
  };
  const m3Hit = m3Rows.filter((r) => {
    const target = pathOf(r.labelEmailLocation.startsWith("http") ? r.labelEmailLocation : `http://x${r.labelEmailLocation}`);
    return sys(r)!.contactPaths.some((u) => pathOf(u) === target);
  }).length;
  metrics.push(
    m3Rows.length === 0
      ? unmeasured("M3", "연락처 페이지 적중률", "후보를 제안한 표본 중 label_email_location 이 채워진 행이 없습니다", "≥ 50%")
      : { id: "M3", label: "연락처 페이지 적중률", threshold: "≥ 50%", proportion: wilson(m3Hit, m3Rows.length) },
  );

  // ── M3b 이메일 공개율 (stop 게이트 입력) ──
  const m3bRows = rows.filter((r) => yesNo(r.labelHasBusinessEmail) !== null);
  labelled["has_business_email"] = m3bRows.length;
  metrics.push(
    m3bRows.length === 0
      ? unmeasured("M3b", "이메일 공개율", "label_has_business_email 이 비어 있습니다", "≥ 30% (< 20% → stop)")
      : {
          id: "M3b",
          label: "이메일 공개율",
          threshold: "≥ 30% (< 20% → stop)",
          proportion: wilson(m3bRows.filter((r) => yesNo(r.labelHasBusinessEmail) === true).length, m3bRows.length),
        },
  );

  // ── M6 ORS 산출 가능률 ──
  const m6Rows = rows.filter((r) => sys(r) !== undefined);
  metrics.push(
    m6Rows.length === 0
      ? unmeasured("M6", "ORS 산출 가능률", "매칭된 표본이 없습니다", "≥ 90%")
      : { id: "M6", label: "ORS 산출 가능률", threshold: "≥ 90%", proportion: wilson(m6Rows.filter((r) => sys(r)!.orsComputed).length, m6Rows.length) },
  );

  // ── M7 ORS ↔ 체감 노출 상관 (stop 게이트 입력) ──
  //
  // ❗ ORS 를 산출하지 못한 업체는 쌍에서 뺀다. 0 으로 채우면 "노출이 없다" 가 되어
  //    상관을 인위적으로 만들어 낸다.
  const m7Pairs = rows
    .map((r) => ({ exposure: likert(r.labelPerceivedExposure), v: sys(r) }))
    .filter((p): p is { exposure: number; v: SystemVerdict } => p.exposure !== null && p.v !== undefined && p.v.orsComputed);
  labelled["perceived_exposure"] = rows.filter((r) => likert(r.labelPerceivedExposure) !== null).length;
  if (m7Pairs.length < 3) {
    metrics.push(
      unmeasured(
        "M7",
        "ORS ↔ 체감 노출 ρ",
        m7Pairs.length === 0
          ? "label_perceived_exposure 가 비어 있거나 ORS 산출 표본이 없습니다"
          : `쌍이 ${m7Pairs.length}개뿐입니다 (n≥3 필요)`,
        "CI 상한 < 0.4 → stop",
      ),
    );
  } else {
    // ORS 대리값: 유효 경쟁사 수가 아니라 실제 ORS 가 필요하다 → 아래 주석 참고.
    metrics.push({
      id: "M7",
      label: "ORS ↔ 체감 노출 ρ",
      threshold: "CI 상한 < 0.4 → stop",
      correlation: spearman(
        m7Pairs.map((p) => p.exposure),
        m7Pairs.map((p) => p.v.validCompetitors),
      ),
      unmeasured:
        "⚠️ 현재 ORS 값 대신 유효 경쟁사 수를 대리값으로 쓴다 — FEATURE_ORS=off 라 " +
        "search_aggregates 에 점유율이 없다. ORS 를 켜기 전에는 M7 을 판정에 쓸 수 없다.",
    });
  }

  // ── M8 경쟁사 선정 타당성 (1~5 평균) ──
  const m8 = rows.map((r) => likert(r.labelCompetitorValidity)).filter((v): v is number => v !== null);
  labelled["competitor_validity"] = m8.length;
  metrics.push(
    m8.length === 0
      ? unmeasured("M8", "경쟁사 선정 타당성", "label_competitor_validity 가 비어 있습니다", "평균 ≥ 3.5")
      : {
          id: "M8",
          label: "경쟁사 선정 타당성",
          threshold: "평균 ≥ 3.5 · 3점 미만 ≤ 20%",
          mean: { value: m8.reduce((s, v) => s + v, 0) / m8.length, n: m8.length },
          proportion: wilson(m8.filter((v) => v < 3).length, m8.length),
        },
  );

  // ── M9 최종 적합률 ──
  const m9Rows = rows.filter((r) => yesNo(r.labelWorthPitching) !== null);
  labelled["worth_pitching"] = m9Rows.length;
  metrics.push(
    m9Rows.length === 0
      ? unmeasured("M9", "최종 적합률", "label_worth_pitching 이 비어 있습니다", "≥ 60%")
      : {
          id: "M9",
          label: "최종 적합률",
          threshold: "≥ 60%",
          proportion: wilson(m9Rows.filter((r) => yesNo(r.labelWorthPitching) === true).length, m9Rows.length),
        },
  );

  // ── M13 렌더링 방식 분포 (실측) ──
  const m13 = rows.filter((r) => r.labelRenderMode !== "");
  labelled["render_mode"] = m13.length;
  metrics.push(
    m13.length === 0
      ? unmeasured("M13", "JS 전용 렌더링 비율", "label_render_mode 가 비어 있습니다")
      : { id: "M13", label: "JS 전용 렌더링 비율", proportion: wilson(m13.filter((r) => r.labelRenderMode === "js_only").length, m13.length) },
  );

  // ── M14 무료메일 대표주소 비율 (실측) ──
  const m14 = rows.filter((r) => yesNo(r.labelEmailIsFreeMail) !== null);
  labelled["email_is_free_mail"] = m14.length;
  metrics.push(
    m14.length === 0
      ? unmeasured("M14", "무료메일 대표주소 비율", "label_email_is_free_mail 이 비어 있습니다")
      : { id: "M14", label: "무료메일 대표주소 비율", proportion: wilson(m14.filter((r) => yesNo(r.labelEmailIsFreeMail) === true).length, m14.length) },
  );

  return { metrics, labelled };
}

/**
 * Phase 0 판정 (설계서 9.1 · R2-06).
 *
 * ❗ **`go` 판정이 없다.** `stop` 또는 `inconclusive` 뿐이다. 게이트 입력이 없으면
 *    `미판정` 이다 — 라벨을 덜 채운 것이 "진행 허용" 으로 바뀌지 않게 한다.
 *
 * 중단 게이트: M3b < 20% 또는 M7 CI 상한 < 0.4
 */
export function decideVerdict(metrics: readonly Metric[]): { verdict: Verdict; reasons: string[] } {
  const find = (id: string): Metric | undefined => metrics.find((m) => m.id === id);
  const m3b = find("M3b");
  const m7 = find("M7");
  const reasons: string[] = [];

  const m3bUsable = m3b?.proportion?.point !== null && m3b?.proportion !== undefined && m3b.unmeasured === undefined;
  const m7Usable = m7?.correlation?.high !== null && m7?.correlation !== undefined && m7.unmeasured === undefined;

  if (!m3bUsable) reasons.push(`M3b 를 쓸 수 없습니다 — ${m3b?.unmeasured ?? "라벨 없음"}`);
  if (!m7Usable) reasons.push(`M7 을 쓸 수 없습니다 — ${m7?.unmeasured ?? "라벨 없음"}`);
  if (!m3bUsable || !m7Usable) {
    reasons.push("게이트 입력이 없으면 inconclusive 도 낼 수 없습니다. 라벨을 채운 뒤 다시 측정하세요.");
    return { verdict: "미판정", reasons };
  }

  const stops: string[] = [];
  if (m3b!.proportion!.point! < 0.2) {
    stops.push(`M3b ${pct(m3b!.proportion!.point)} < 20% — 이메일 공개율이 낮아 export 가능 리드가 0 에 수렴합니다`);
  }
  if (m7!.correlation!.high! < 0.4) {
    stops.push(`M7 CI 상한 ${m7!.correlation!.high!.toFixed(3)} < 0.4 — ORS 가 체감 노출을 설명하지 못합니다`);
  }

  if (stops.length > 0) return { verdict: "stop", reasons: stops };
  return {
    verdict: "inconclusive",
    reasons: [
      "중단 게이트를 넘지 않았습니다. Phase 1 진행이 허용됩니다.",
      "❗ SLA·배점은 확정하지 않습니다 (설계서 R2-06 — Phase 0 결과로 final_max·ORS 배점을 정하지 않는다).",
    ],
  };
}

// ─────────────────────────────────────────────────────────── 실행

export interface RunMeasureOptions {
  goldsetPath: string;
  databaseUrl: string;
  logger: Logger;
}

export async function runMeasure(options: RunMeasureOptions): Promise<MeasureReport> {
  const rows = readGoldset(options.goldsetPath);
  if (rows.length === 0) throw new Error(`골드셋에 행이 없습니다: ${options.goldsetPath}`);

  const sql = postgres(options.databaseUrl, { max: 2, onnotice: () => {} });
  try {
    const verdicts = await loadSystemVerdicts(sql, rows);
    if (verdicts.size === 0) {
      throw new Error(
        "표본과 매칭되는 파이프라인 출력이 DB 에 없습니다.\n" +
          "  측정은 **실제로 돌아간 출력**을 읽습니다. 이 표본으로 먼저 파이프라인을 실행하세요:\n" +
          "    pnpm worker run --industry=<업종>\n" +
          "  (매칭은 raw_candidates(source, external_id) 기준입니다)",
      );
    }

    const { metrics, labelled } = computeMetrics(rows, verdicts);
    const { verdict, reasons } = decideVerdict(metrics);

    const industries = [...new Set(rows.map((r) => r.industry))];
    const perIndustry = industries.map((industry) => {
      const subset = rows.filter((r) => r.industry === industry && yesNo(r.labelWorthPitching) !== null);
      return {
        industry,
        n: subset.length,
        m9: wilson(subset.filter((r) => yesNo(r.labelWorthPitching) === true).length, subset.length),
      };
    });

    options.logger.info("spike.measure.done", {
      total: rows.length,
      matched: verdicts.size,
      verdict,
    });

    return {
      measuredAt: new Date().toISOString(),
      goldsetPath: options.goldsetPath,
      total: rows.length,
      matched: verdicts.size,
      labelled,
      metrics,
      verdict,
      verdictReasons: reasons,
      perIndustry,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export function formatMeasureReport(report: MeasureReport): string {
  const metricRows = report.metrics.map((m) => {
    const value = m.correlation
      ? m.correlation.rho === null
        ? "—"
        : `ρ ${m.correlation.rho.toFixed(3)}`
      : m.mean
        ? m.mean.value === null
          ? "—"
          : `평균 ${m.mean.value.toFixed(2)}`
        : pct(m.proportion?.point ?? null);
    const interval = m.correlation
      ? m.correlation.low === null || m.correlation.high === null
        ? "—"
        : `[${m.correlation.low.toFixed(3)}, ${m.correlation.high.toFixed(3)}]`
      : m.proportion
        ? ci(m.proportion)
        : "—";
    const n = m.correlation
      ? String(m.correlation.n)
      : m.mean
        ? String(m.mean.n)
        : m.proportion
          ? String(m.proportion.denominator)
          : "0";
    return [m.id, m.label, m.unmeasured ? "미측정" : value, m.unmeasured ? "—" : interval, n, m.threshold ?? "-"];
  });

  const notes = report.metrics
    .filter((m) => m.unmeasured !== undefined)
    .map((m) => `  · ${m.id}: ${m.unmeasured}`);

  const industryRows = report.perIndustry.map((p) => [
    p.industry in INDUSTRY_LABEL ? INDUSTRY_LABEL[p.industry as Industry] : p.industry,
    String(p.n),
    pct(p.m9.point),
    ci(p.m9),
  ]);

  const verdictBanner =
    report.verdict === "stop"
      ? "■ 판정: stop — 중단 게이트에 걸렸습니다"
      : report.verdict === "inconclusive"
        ? "■ 판정: inconclusive — Phase 1 진행 허용"
        : "■ 판정: 미판정 — 게이트 입력이 없습니다";

  return [
    "",
    "■ 골드셋 측정 (설계서 9.1 · Phase 0 탐색적 검증)",
    "",
    `  골드셋 ${report.goldsetPath}`,
    `  표본 ${report.total} 건 · 파이프라인 출력 매칭 ${report.matched} 건`,
    "",
    "  라벨 채움 현황",
    ...Object.entries(report.labelled).map(([k, v]) => `    ${k.padEnd(22)} ${v}/${report.total}`),
    "",
    renderTable(["#", "지표", "점추정", "95% CI", "n", "기준"], metricRows),
    "",
    ...(notes.length > 0 ? ["  미측정·주의 사항", ...notes, ""] : []),
    "  업종별 최종 적합률 (M9)",
    renderTable(["업종", "n", "적합률", "95% CI"], industryRows),
    "",
    verdictBanner,
    ...report.verdictReasons.map((r) => `    ${r}`),
    "",
    "  ❗ 가설검정을 하지 않습니다 — 점추정 + 95% CI 만 보고합니다 (설계서 9.1).",
    "  ❗ 'go' 판정은 없습니다 (R2-06). Phase 0 결과로 final_max·ORS 배점을 정하지 않습니다.",
    "",
  ].join("\n");
}
