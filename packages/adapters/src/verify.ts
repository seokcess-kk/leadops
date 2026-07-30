import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LeadOpsError, redactUrl, type Industry, type Logger } from "@leadops/core";
import type { HttpClient } from "@leadops/http";
import { encodeServiceKey } from "./dataGoKr";
import { HIRA_CODES, NAME_KEYWORD, type HiraHospitalItem } from "./hira";
import type { FtcBrandItem } from "./ftc";

/**
 * 어댑터 실 API 검증.
 *
 * 설계서 11장: "가짜 응답만으로 완료 처리하지 않는다."
 * 어댑터의 엔드포인트와 코드값은 공개 문서만으로 확정할 수 없었다
 * (data.go.kr 은 스펙을 가이드 문서·Swagger 로만 제공한다).
 *
 * 그래서 **읽어서 확인하지 않고 호출해서 확인한다**:
 *   1. 엔드포인트 후보를 순서대로 두드려 실제로 응답하는 것을 찾는다
 *   2. 응답 필드가 우리 매핑과 맞는지 확인한다
 *   3. 코드값(진료과목·종별)이 맞는지 **경험적으로** 확인한다
 *   4. 실제 응답을 fixture 로 녹화해 회귀 테스트 입력으로 쓴다
 *
 * 3번은 휴리스틱이다. `dgsbjtCd=14` 가 피부과라면 반환된 기관명 대부분에
 * "피부과" 가 들어 있어야 한다. 코드가 틀리면 그 비율이 0 에 가깝다.
 * **이것은 증명이 아니라 강한 신호다.** 리포트에 그렇게 표기한다.
 */

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  /** 이 검사가 무엇을 증명하는가(또는 증명하지 못하는가). */
  detail: string;
  evidence?: string;
}

export interface AdapterVerification {
  adapter: string;
  /** 실제로 응답한 엔드포인트. 후보 탐색 결과. */
  workingEndpoint?: string;
  checks: CheckResult[];
  status: CheckStatus;
}

export interface VerifyOptions {
  http: HttpClient;
  serviceKey: string;
  logger: Logger;
  /** 실제 응답을 저장할 디렉터리. 지정하지 않으면 녹화하지 않는다. */
  fixtureDir?: string;
}

// ── 엔드포인트 후보 ──────────────────────────────────────────────────────────
//
// 첫 번째가 우리가 코드에 적어 둔 값이다. 나머지는 문서·커뮤니티에서 관찰된 변형이다.
// 실제로 응답하는 것을 찾으면 리포트가 그 값을 알려주고, 우리는 코드를 그것으로 고친다.

const HIRA_ENDPOINT_CANDIDATES = [
  "https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList",
  "https://apis.data.go.kr/B551182/hospInfoService1/getHospBasisList",
  "https://apis.data.go.kr/B551182/hospInfoService/getHospBasisList",
  "http://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList",
] as const;

/**
 * 의료기관별상세정보서비스 (data.go.kr 15001699).
 *
 * `getDgsbjtInfo` 는 요양기관 하나의 **진료과목 코드와 이름을 함께** 돌려준다.
 * 이름 기반 휴리스틱과 달리 이것은 코드→이름의 **직접 증거**다.
 * 별도 활용신청이 필요하지만, 한 번 되면 추측이 사라진다.
 */
const HIRA_DGSBJT_ENDPOINT_CANDIDATES = [
  "https://apis.data.go.kr/B551182/MadmDtlInfoService2/getDgsbjtInfo2",
  "https://apis.data.go.kr/B551182/MadmDtlInfoService2.7/getDgsbjtInfo2.7",
  "https://apis.data.go.kr/B551182/MadmDtlInfoService/getDgsbjtInfo",
] as const;

interface DgsbjtItem {
  dgsbjtCd?: string;
  dgsbjtCdNm?: string;
  dgsbjtPrSdrCnt?: number | string;
}

const FTC_ENDPOINT_CANDIDATES = [
  "https://apis.data.go.kr/1130000/FftcBrandRegistrationService/getBrandRegistrationList",
  "https://apis.data.go.kr/1130000/FftcBrandRegistrationService/getBrandRegistration",
  "https://apis.data.go.kr/1130000/FftcBrandRegistrationService2/getBrandRegistrationList",
] as const;

interface ProbeResult {
  endpoint: string;
  url: string;
  body: string;
  /** 표준 봉투를 파싱할 수 있었는지. */
  parsed?: { resultCode?: string; resultMsg?: string; totalCount?: number; items: unknown[] };
}

/**
 * data.go.kr 이 오류 **본문**에 담아 보내는 코드. 상태 코드보다 훨씬 구체적이다.
 *
 * XML: <returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg>
 * JSON: { resultCode: "30", resultMsg: "..." }
 */
const PORTAL_ERROR_HINTS: ReadonlyArray<{ pattern: RegExp; hint: string }> = [
  { pattern: /NO_OPENAPI_SERVICE_ERROR/, hint: "**경로가 틀렸습니다** — 그런 서비스가 없습니다" },
  {
    pattern: /SERVICE_KEY_IS_NOT_REGISTERED_ERROR/,
    hint: "**이 데이터셋을 활용신청하지 않았습니다** (또는 승인 대기 중). data.go.kr 에서 신청하세요",
  },
  { pattern: /SERVICE_ACCESS_DENIED_ERROR/, hint: "활용신청이 승인되지 않았습니다" },
  { pattern: /LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR/, hint: "일일 트래픽 한도를 초과했습니다" },
  { pattern: /DEADLINE_HAS_EXPIRED_ERROR/, hint: "활용 기간이 만료됐습니다. 연장 신청하세요" },
  { pattern: /UNREGISTERED_IP_ERROR/, hint: "등록되지 않은 IP 입니다" },
  { pattern: /INVALID_REQUEST_PARAMETER_ERROR/, hint: "요청 파라미터가 잘못됐습니다 (경로는 맞습니다)" },
  { pattern: /HTTP_ERROR|APPLICATION_ERROR/, hint: "포털 내부 오류입니다. 잠시 후 재시도하세요" },
];

/** 오류 본문에서 포털 에러 코드를 뽑아 사람이 읽을 진단으로 바꾼다. */
function diagnoseBody(status: number, body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  for (const { pattern, hint } of PORTAL_ERROR_HINTS) {
    if (pattern.test(compact)) {
      const code = pattern.exec(compact)![0];
      return `HTTP ${status} · ${code} — ${hint}`;
    }
  }

  const statusHint =
    status === 401
      ? "경로는 존재하지만 키가 거부됐습니다 → **경로는 맞습니다.** Decoding 키인지 확인하세요"
      : status === 403
        ? "활용신청 승인 대기 중이거나 트래픽 한도를 초과했습니다"
        : status === 404
          ? "경로가 존재하지 않습니다"
          : status >= 500
            ? "포털이 500 을 돌려줬습니다"
            : "";
  const excerpt = compact.slice(0, 200);
  return `HTTP ${status}${statusHint ? ` — ${statusHint}` : ""}${excerpt ? `\n     응답: ${excerpt}` : ""}`;
}

function diagnose(err: unknown): string {
  if (!(err instanceof LeadOpsError)) return String(err);
  const status = err.details["status"];
  if (typeof status !== "number") return `[${err.code}] ${err.message}`;
  return diagnoseBody(status, "");
}

/** 후보 엔드포인트를 순서대로 두드려 실제로 데이터를 주는 것을 찾는다. */
async function probeEndpoints(
  http: HttpClient,
  serviceKey: string,
  candidates: readonly string[],
  params: Record<string, string | number>,
  logger: Logger,
): Promise<{ found?: ProbeResult; attempts: Array<{ endpoint: string; error: string }> }> {
  const attempts: Array<{ endpoint: string; error: string }> = [];

  for (const endpoint of candidates) {
    const url = new URL(endpoint);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
    qs.set("_type", "json");
    // DataGoKrClient 와 **같은 방식**으로 만들어야 검증이 실제 호출 경로를 대표한다.
    url.search = `serviceKey=${encodeServiceKey(serviceKey)}&${qs.toString()}`;

    logger.info("verify.probe", { endpoint });
    try {
      const res = await http.get(url.href, {
        acceptContentTypes: ["application/json", "text/json", "text/plain", "application/xml", "text/xml", "text/html"],
        // 탐색에서는 실패가 곧 정보다. 재시도는 시간만 쓰고 상대 서버에 부담만 준다.
        maxRetries: 0,
        // ❗ 오류 본문에 포털의 실제 에러 코드가 들어 있다. 상태 코드만 보고 던지면 버려진다.
        allowErrorStatuses: true,
      });

      if (res.status >= 400) {
        attempts.push({ endpoint, error: diagnoseBody(res.status, res.body) });
        continue;
      }

      const parsed = looseParse(res.body);
      if (parsed?.resultCode === "00") {
        return { found: { endpoint, url: url.href, body: res.body, parsed }, attempts };
      }
      attempts.push({
        endpoint,
        error: parsed?.resultCode
          ? `resultCode=${parsed.resultCode} ${parsed.resultMsg ?? ""}`
          : diagnoseBody(res.status, res.body),
      });
    } catch (err) {
      attempts.push({ endpoint, error: diagnose(err) });
    }
  }
  return { attempts };
}

/** 검증 단계에서는 엄격 파서 대신 관대하게 읽는다. 무엇이 왔는지 봐야 하기 때문이다. */
function looseParse(body: string): ProbeResult["parsed"] | undefined {
  try {
    const root = JSON.parse(body) as { response?: { header?: Record<string, string>; body?: Record<string, unknown> } };
    const header = root.response?.header;
    const b = root.response?.body;
    const rawItems = b?.["items"];
    let items: unknown[] = [];
    if (Array.isArray(rawItems)) items = rawItems;
    else if (rawItems && typeof rawItems === "object") {
      const inner = (rawItems as { item?: unknown }).item;
      items = Array.isArray(inner) ? inner : inner ? [inner] : [];
    }
    const result: ProbeResult["parsed"] = { items };
    if (header?.["resultCode"] !== undefined) result.resultCode = header["resultCode"];
    if (header?.["resultMsg"] !== undefined) result.resultMsg = header["resultMsg"];
    const tc = Number(b?.["totalCount"]);
    if (Number.isFinite(tc)) result.totalCount = tc;
    return result;
  } catch {
    return undefined;
  }
}

/** fixture 에 남길 항목 수. 회귀 테스트는 매핑을 보는 것이지 데이터를 쌓는 것이 아니다. */
const FIXTURE_ITEMS = 5;

/**
 * 실응답을 회귀 테스트 입력으로 녹화한다.
 *
 * 항목을 몇 건만 남기고 자른다. 이유가 두 가지다.
 *  1. 이 파일은 **커밋된다.** 실행할 때마다 100건이 통째로 바뀌면 diff 를 읽을 수 없다.
 *  2. 공개 데이터라 재배포가 허용돼 있어도, 회귀 테스트에 필요한 만큼만 담는 편이 낫다.
 *
 * `totalCount` 는 자르지 않는다 — 모집단 크기는 그 자체가 검증 결과다.
 */
function recordFixture(dir: string | undefined, name: string, body: string): string | undefined {
  if (!dir) return undefined;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);

  let out = body;
  try {
    const doc = JSON.parse(body) as Record<string, any>;
    const responseBody = doc?.["response"]?.["body"];
    const item = responseBody?.["items"]?.["item"];
    if (Array.isArray(item)) {
      responseBody["items"]["item"] = item.slice(0, FIXTURE_ITEMS);
      responseBody["numOfRows"] = Math.min(FIXTURE_ITEMS, item.length);
      out = `${JSON.stringify(doc, null, 2)}\n`;
    }
  } catch {
    // JSON 이 아니면 원문 그대로 남긴다 — 형태를 모르는 응답일수록 원본이 중요하다.
  }

  writeFileSync(path, out, "utf8");
  return path;
}

// ── HIRA ─────────────────────────────────────────────────────────────────────

const HIRA_PARAMS: Record<Exclude<Industry, "franchise">, Record<string, string>> = {
  derm: { dgsbjtCd: HIRA_CODES.dgsbjt_derm, clCd: HIRA_CODES.cl_clinic },
  plastic: { dgsbjtCd: HIRA_CODES.dgsbjt_plastic, clCd: HIRA_CODES.cl_clinic },
  dental: { clCd: HIRA_CODES.cl_dental_clinic },
};

export async function verifyHira(options: VerifyOptions): Promise<AdapterVerification> {
  const { http, serviceKey, logger, fixtureDir } = options;
  const checks: CheckResult[] = [];

  const probe = await probeEndpoints(
    http,
    serviceKey,
    HIRA_ENDPOINT_CANDIDATES,
    { ...HIRA_PARAMS.derm, pageNo: 1, numOfRows: 30 },
    logger,
  );

  if (!probe.found) {
    checks.push({
      name: "엔드포인트",
      status: "fail",
      detail: "후보 중 어느 것도 정상 응답하지 않았습니다. 키가 잘못됐거나 경로가 바뀌었습니다.",
      evidence: probe.attempts.map((a) => `${a.endpoint}\n  → ${a.error}`).join("\n"),
    });
    return { adapter: "hira_hospital", checks, status: "fail" };
  }

  const working = probe.found;
  checks.push({
    name: "엔드포인트",
    status: working.endpoint === HIRA_ENDPOINT_CANDIDATES[0] ? "pass" : "warn",
    detail:
      working.endpoint === HIRA_ENDPOINT_CANDIDATES[0]
        ? "코드에 적힌 엔드포인트가 정상 동작합니다."
        : `코드에 적힌 값이 아닌 다른 후보가 동작했습니다. hira.ts 의 ENDPOINT 를 이 값으로 고치세요.`,
    evidence: working.endpoint,
  });

  const fixture = recordFixture(fixtureDir, "hira-getHospBasisList-derm", working.body);
  if (fixture) {
    checks.push({ name: "fixture 녹화", status: "pass", detail: "회귀 테스트 입력으로 저장했습니다.", evidence: fixture });
  }

  // ── 응답 필드가 우리 매핑과 맞는가 ──
  const items = working.parsed?.items as HiraHospitalItem[] | undefined;
  if (!items || items.length === 0) {
    checks.push({
      name: "응답 항목",
      status: "fail",
      detail: `resultCode 는 00 이지만 항목이 0건입니다. 질의 파라미터가 잘못됐을 수 있습니다.`,
      evidence: `totalCount=${working.parsed?.totalCount ?? "?"}`,
    });
    return { adapter: "hira_hospital", workingEndpoint: working.endpoint, checks, status: "fail" };
  }

  const required = ["ykiho", "yadmNm"] as const;
  const missing = required.filter((f) => items.every((it) => !it[f]));
  checks.push({
    name: "필수 필드",
    status: missing.length === 0 ? "pass" : "fail",
    detail:
      missing.length === 0
        ? "ykiho·yadmNm 이 존재합니다. mapHiraItem 이 동작합니다."
        : `필드 누락: ${missing.join(", ")}. hira.ts 의 HiraHospitalItem 을 실제 응답에 맞추세요.`,
    evidence: `관찰된 키: ${[...new Set(items.flatMap((i) => Object.keys(i)))].join(", ")}`,
  });

  const optional = ["addr", "telno", "hospUrl", "sgguCdNm", "drTotCnt", "XPos", "YPos"] as const;
  const present = optional.filter((f) => items.some((it) => it[f] !== undefined && it[f] !== ""));
  checks.push({
    name: "선택 필드",
    status: present.includes("addr") ? "pass" : "warn",
    detail: "주소·전화·홈페이지가 오는지 확인합니다. hospUrl 이 없으면 홈페이지 판별을 검색으로 해야 합니다.",
    evidence: `존재: ${present.join(", ") || "(없음)"} / 부재: ${optional.filter((f) => !present.includes(f)).join(", ") || "(없음)"}`,
  });

  // ── 코드값 검사 ──
  //
  // ❗ 종별(clCd)과 진료과목(dgsbjtCd)은 검증 방법이 달라야 한다.
  //
  //   clCd 는 기관 종류이므로 이름이 그대로 따라온다 (치과의원 → 이름에 '치과').
  //     → 단순 비율로 충분하다.
  //
  //   dgsbjtCd 는 **신고한 진료과목**이라 이름과 무관하다. 일반의원이 피부과를
  //     진료과목으로 신고하는 일이 흔하다(2025년 일반의 신규개원 285곳 중 243곳).
  //     → 단순 비율은 낮게 나온다. **대조군 대비 상승도(lift)** 로 봐야 한다.

  const SAMPLE = 100;
  const sampleNames = async (params: Record<string, string | number>): Promise<{ names: string[]; total?: number; body?: string }> => {
    const p = await probeEndpoints(http, serviceKey, [working.endpoint], { ...params, pageNo: 1, numOfRows: SAMPLE }, logger);
    const rows = (p.found?.parsed?.items ?? []) as HiraHospitalItem[];
    const out: { names: string[]; total?: number; body?: string } = {
      names: rows.map((r) => r.yadmNm ?? ""),
    };
    if (p.found?.parsed?.totalCount !== undefined) out.total = p.found.parsed.totalCount;
    if (p.found?.body !== undefined) out.body = p.found.body;
    return out;
  };
  const share = (names: readonly string[], keyword: string): number =>
    names.length === 0 ? 0 : names.filter((n) => n.includes(keyword)).length / names.length;

  // ── 결정적 방법 우선: 진료과목 코드표를 직접 읽는다 ──
  //
  // 이름 기반 휴리스틱은 피부과처럼 **신고가 널리 퍼진 과목**에서 무력하다.
  // 실제 피부과 의원이 전체의 2% 뿐이라 표본 100건으로는 2%와 4%를 구분할 수 없다.
  // 반면 getDgsbjtInfo 는 코드와 이름을 함께 주므로 추측이 필요 없다.
  const codeTable = await fetchDgsbjtCodeTable(http, serviceKey, logger, items);
  if (codeTable.size > 0) {
    const expect: Array<[string, string]> = [
      [HIRA_CODES.dgsbjt_derm, "피부과"],
      [HIRA_CODES.dgsbjt_plastic, "성형외과"],
    ];
    for (const [code, expected] of expect) {
      const actual = codeTable.get(code);
      checks.push({
        name: `진료과목 코드표 (dgsbjtCd=${code})`,
        status: actual === undefined ? "warn" : actual === expected ? "pass" : "fail",
        detail:
          actual === undefined
            ? `표본에서 이 코드를 관찰하지 못했습니다. 표본을 늘리거나 아래 휴리스틱 결과를 보세요.`
            : actual === expected
              ? `**확정** — getDgsbjtInfo 가 '${actual}' 로 알려줍니다. 휴리스틱이 아닙니다.`
              : `**틀렸습니다** — 이 코드는 '${expected}' 가 아니라 '${actual}' 입니다.`,
        evidence:
          `관찰된 코드표: ` +
          [...codeTable.entries()].map(([c, n]) => `${c}=${n}`).sort().join(", "),
      });
    }

    // 기대한 이름을 가진 코드가 표에 있으면 알려준다.
    for (const wanted of ["피부과", "성형외과"]) {
      const hit = [...codeTable.entries()].find(([, n]) => n === wanted);
      if (hit) {
        checks.push({
          name: `'${wanted}' 의 실제 코드`,
          status: "pass",
          detail: `**확정: dgsbjtCd=${hit[0]}**`,
          evidence: "getDgsbjtInfo 응답에서 직접 읽은 값입니다.",
        });
      }
    }
  } else {
    checks.push({
      name: "진료과목 코드표",
      status: "warn",
      detail:
        "의료기관별상세정보서비스(15001699)에 접근할 수 없어 코드표를 직접 읽지 못했습니다. " +
        "다만 **이것이 없어도 코드는 확정된다** — 아래 '진료과목 코드' 검사가 이름 → 코드 " +
        "방향의 전수 카운트로 판정하므로 표본 오차가 없다. 코드표는 전체 목록을 한 번에 " +
        "보고 싶을 때만 필요하다.",
      evidence: HIRA_DGSBJT_ENDPOINT_CANDIDATES.join("\n"),
    });
  }


  /**
   * ❗ 결정적 검증 — **방향을 뒤집는다.**
   *
   * "코드 X 로 거른 기관 중 이름에 '피부과' 가 몇 %인가" 는 답이 흐리다. 피부과는
   * 전체 의원의 45%(37,819 중 16,987)가 신고하는 과목이라 표본이 통째로 희석된다.
   * 실측에서 이 방향은 상승도 1.0 배가 나왔다 — 코드가 맞는데도 틀린 것처럼 보였다.
   *
   * 대신 **"이름이 '피부과' 인 기관은 어떤 코드를 신고했는가"** 를 묻는다.
   * 이쪽은 답이 하나다: 피부과 의원은 거의 전부 피부과를 신고한다.
   * 게다가 `totalCount` 끼리 비교하므로 **표본 오차가 아예 없다.**
   *
   * 실측(2026-07-30): 이름에 '피부과' 가 든 의원 1,555곳 중 1,553곳(99.9%)이
   * `dgsbjtCd=14`. 성형외과는 1,236곳 중 1,233곳(99.8%)이 `dgsbjtCd=08`.
   */
  const countOnly = async (params: Record<string, string | number>): Promise<number | undefined> => {
    const p = await probeEndpoints(
      http, serviceKey, [working.endpoint], { ...params, pageNo: 1, numOfRows: 1 }, logger,
    );
    return p.found?.parsed?.totalCount;
  };

  /** 이름에 키워드가 든 기관 중 이 코드를 신고한 비율. 이보다 낮으면 코드가 틀렸다. */
  const NAME_TO_CODE_MIN = 0.9;

  /** 코드가 틀렸을 때 올바른 코드를 같은 방법으로 찾아 준다. */
  const discoverByName = async (keyword: string, withName: number): Promise<string> => {
    const found: Array<{ code: string; ratio: number; n: number }> = [];
    for (let n = 0; n <= 30; n++) {
      const code = String(n).padStart(2, "0");
      const hit = await countOnly({ clCd: HIRA_CODES.cl_clinic, yadmNm: keyword, dgsbjtCd: code });
      if (hit !== undefined && hit / withName >= NAME_TO_CODE_MIN) found.push({ code, ratio: hit / withName, n: hit });
    }
    if (found.length === 0) return "    탐색 결과: 00~30 중 기준을 넘는 코드가 없습니다.";
    found.sort((a, b) => b.ratio - a.ratio);
    const lines = found.map(
      (f) => `      dgsbjtCd=${f.code} → ${f.n}/${withName} (${(f.ratio * 100).toFixed(1)}%)`,
    );
    return ["    탐색 결과 (이름 → 코드, 전수 카운트):", ...lines].join("\n");
  };

  /** @returns 결정적으로 판정했으면 true. 이름 필터를 지원하지 않으면 false (휴리스틱으로 넘어간다). */
  const verifyCodeByName = async (industry: "derm" | "plastic"): Promise<boolean> => {
    const keyword = NAME_KEYWORD[industry];
    const code = String(HIRA_PARAMS[industry]["dgsbjtCd"]);
    const withName = await countOnly({ clCd: HIRA_CODES.cl_clinic, yadmNm: keyword });
    if (withName === undefined || withName === 0) return false; // yadmNm 필터 미지원

    const withBoth = await countOnly({ clCd: HIRA_CODES.cl_clinic, yadmNm: keyword, dgsbjtCd: code });
    if (withBoth === undefined) return false;

    const ratio = withBoth / withName;
    const ok = ratio >= NAME_TO_CODE_MIN;
    checks.push({
      name: `진료과목 코드 (${industry}: dgsbjtCd=${code})`,
      status: ok ? "pass" : "fail",
      detail: ok
        ? `**확정** — 이름이 '${keyword}' 인 의원의 ${(ratio * 100).toFixed(1)}% 가 이 코드를 신고했습니다. ` +
          `전수 카운트 비교라 표본 오차가 없습니다.`
        : `이름이 '${keyword}' 인 의원 중 ${(ratio * 100).toFixed(1)}% 만 이 코드를 신고했습니다. ` +
          `기준 ${NAME_TO_CODE_MIN * 100}% 미달 — 코드가 틀렸습니다.`,
      evidence:
        `이름에 '${keyword}' 포함 의원 ${withName}곳 중 dgsbjtCd=${code} 신고 ${withBoth}곳` +
        (ok ? "" : `\n${await discoverByName(keyword, withName)}`),
    });
    return true;
  };

  const decided: Record<string, boolean> = {};
  for (const industry of ["derm", "plastic"] as const) {
    decided[industry] = await verifyCodeByName(industry);
    // 판정 방법과 무관하게 업종별 실응답을 녹화한다 (회귀 테스트 입력).
    if (decided[industry]) {
      const s = await sampleNames(HIRA_PARAMS[industry]);
      if (s.body) recordFixture(fixtureDir, `hira-getHospBasisList-${industry}`, s.body);
    }
  }

  // 대조군: 진료과목 필터 없이 의원 전체 (역방향 검증이 불가능할 때의 폴백)
  const control = await sampleNames({ clCd: HIRA_CODES.cl_clinic });
  checks.push({
    name: "대조군 표본",
    status: control.names.length > 0 ? "pass" : "fail",
    detail: "진료과목 필터 없이 의원 전체를 뽑아 기준 비율을 만듭니다. 진료과목 코드 검증의 기준선입니다.",
    evidence:
      `의원 총 ${control.total ?? "?"}건 중 ${control.names.length}건 표본. ` +
      `기준 비율 — 피부과 ${(share(control.names, "피부과") * 100).toFixed(1)}% / ` +
      `성형외과 ${(share(control.names, "성형외과") * 100).toFixed(1)}%`,
  });

  /**
   * 설정된 코드가 틀렸을 때 **올바른 코드를 찾아준다**.
   *
   * 진료과목 코드를 00~25 까지 훑으며 대조군 대비 상승도를 재고, 상위 3개를 보고한다.
   * "틀렸다" 로 끝나지 않고 "이 값이 맞다" 까지 알려주는 것이 이 도구의 목적이다.
   */
  const discoverDgsbjtCode = async (keyword: string): Promise<string> => {
    const base = share(control.names, keyword);
    const found: Array<{ code: string; lift: number; pct: number; total?: number }> = [];

    logger.info("verify.discover.start", { keyword });
    for (let n = 0; n <= 25; n++) {
      const code = String(n).padStart(2, "0");
      const s = await sampleNames({ clCd: HIRA_CODES.cl_clinic, dgsbjtCd: code });
      if (s.names.length === 0) continue;
      const pct = share(s.names, keyword);
      const lift = base === 0 ? (pct > 0 ? Infinity : 0) : pct / base;
      if (lift >= 1.5) {
        const entry: { code: string; lift: number; pct: number; total?: number } = { code, lift, pct };
        if (s.total !== undefined) entry.total = s.total;
        found.push(entry);
      }
    }
    found.sort((a, b) => b.lift - a.lift);

    if (found.length === 0) return "  탐색 결과: 00~25 중 유의미한 코드를 찾지 못했습니다.";
    return (
      "  탐색 결과 (상승도 순):\n" +
      found
        .slice(0, 3)
        .map(
          (f) =>
            `    dgsbjtCd=${f.code} → '${keyword}' ${(f.pct * 100).toFixed(1)}% (${fmtLift(f.lift)}배), 총 ${f.total ?? "?"}건`,
        )
        .join("\n")
    );
  };

  // 진료과목 코드 폴백: 대조군 대비 상승도로 판정.
  // ❗ 역방향(이름 → 코드) 검증이 성공했으면 **돌리지 않는다.** 이 휴리스틱은 신고가
  //    널리 퍼진 과목에서 틀린 답을 내므로, 확정된 결과 옆에 두면 혼란만 준다.
  for (const industry of ["derm", "plastic"] as const) {
    if (decided[industry]) continue;
    const keyword = NAME_KEYWORD[industry];
    const other = industry === "derm" ? "성형외과" : "피부과";
    const s = await sampleNames(HIRA_PARAMS[industry]);
    if (s.body) recordFixture(fixtureDir, `hira-getHospBasisList-${industry}`, s.body);

    const base = share(control.names, keyword);
    const got = share(s.names, keyword);
    const lift = base === 0 ? (got > 0 ? Infinity : 0) : got / base;

    // 교차 확인: 이 코드가 정말 이 과목이라면, 반대 과목의 상승도보다 커야 한다.
    const otherBase = share(control.names, other);
    const otherGot = share(s.names, other);
    const otherLift = otherBase === 0 ? (otherGot > 0 ? Infinity : 0) : otherGot / otherBase;

    const ok = s.names.length > 0 && lift >= 1.5 && lift > otherLift;

    // 틀렸으면 "틀렸다"로 끝내지 않고 올바른 코드를 찾아 알려준다.
    const discovery = ok ? "" : `\n${await discoverDgsbjtCode(keyword)}`;

    checks.push({
      name: `진료과목 코드 (${industry}: dgsbjtCd=${HIRA_PARAMS[industry]["dgsbjtCd"]})`,
      status: s.names.length === 0 ? "fail" : ok ? "pass" : "fail",
      detail:
        s.names.length === 0
          ? "항목이 0건입니다. 코드값이 틀렸을 가능성이 큽니다."
          : `'${keyword}' 비율이 대조군 대비 ${fmtLift(lift)}배. 반대 과목('${other}')은 ${fmtLift(otherLift)}배. ` +
            `**증명이 아니라 신호입니다** — 진료과목은 신고 항목이라 기관명과 다를 수 있으므로 ` +
            `절대 비율이 아니라 상승도로 봅니다. 기준: 1.5배 이상이고 반대 과목보다 커야 통과.`,
      evidence:
        `총 ${s.total ?? "?"}건 중 ${s.names.length}건 표본. ` +
        `'${keyword}' ${(got * 100).toFixed(1)}% (대조군 ${(base * 100).toFixed(1)}%) / ` +
        `'${other}' ${(otherGot * 100).toFixed(1)}% (대조군 ${(otherBase * 100).toFixed(1)}%)\n` +
        `예: ${s.names.slice(0, 3).join(" / ") || "(없음)"}` +
        discovery,
    });
  }

  // 종별 코드: 이름이 종류를 따라오므로 단순 비율로 충분하다.
  {
    const s = await sampleNames(HIRA_PARAMS.dental);
    if (s.body) recordFixture(fixtureDir, "hira-getHospBasisList-dental", s.body);
    const ratio = share(s.names, "치과");
    checks.push({
      name: `종별 코드 (dental: clCd=${HIRA_CODES.cl_dental_clinic})`,
      status: s.names.length > 0 && ratio >= 0.8 ? "pass" : "fail",
      detail:
        `기관명에 '치과' 가 포함된 비율 ${(ratio * 100).toFixed(0)}%. ` +
        `종별은 기관 종류이므로 이름이 따라옵니다. 기준: 80% 이상.`,
      evidence: `총 ${s.total ?? "?"}건 중 ${s.names.length}건 표본. 예: ${s.names.slice(0, 3).join(" / ") || "(없음)"}`,
    });
  }

  return {
    adapter: "hira_hospital",
    workingEndpoint: working.endpoint,
    checks,
    status: worstStatus(checks),
  };
}

// ── 공정위 ───────────────────────────────────────────────────────────────────

export async function verifyFtc(options: VerifyOptions): Promise<AdapterVerification> {
  const { http, serviceKey, logger, fixtureDir } = options;
  const checks: CheckResult[] = [];

  const probe = await probeEndpoints(http, serviceKey, FTC_ENDPOINT_CANDIDATES, { pageNo: 1, numOfRows: 30 }, logger);

  if (!probe.found) {
    // ❗ 음성 대조군. 존재하지 않는 것이 확실한 경로를 함께 두드려 본다.
    //    포털이 미등록 서비스와 잘못된 경로에 **똑같은 응답**을 준다면, 후보들의 실패는
    //    "경로가 틀렸다" 는 근거가 되지 못한다. 그 사실을 감추면 있지도 않은 단서를
    //    쫓아 경로를 계속 추측하게 된다.
    const controlPath = "https://apis.data.go.kr/1130000/NoSuchServiceXYZ/getNothing";
    const controlProbe = await probeEndpoints(http, serviceKey, [controlPath], { pageNo: 1, numOfRows: 1 }, logger);
    const controlError = controlProbe.attempts[0]?.error ?? "(응답 없음)";
    const sameAsControl = probe.attempts.every((a) => a.error === controlError);

    checks.push({
      name: "엔드포인트",
      status: "fail",
      detail: sameAsControl
        ? "후보 중 어느 것도 정상 응답하지 않았습니다. **다만 이 응답은 진단에 쓸 수 없습니다** — " +
          "존재하지 않는 것이 확실한 대조 경로가 똑같은 응답을 돌려줍니다. " +
          "경로 오류·활용신청 미승인·서비스 장애를 구분할 수 없으므로 경로 추측은 무의미합니다. " +
          "data.go.kr 활용신청 상세의 가이드 문서에서 요청주소를 확인해 ftc.ts 의 ENDPOINTS 에 넣으세요."
        : "후보 중 어느 것도 정상 응답하지 않았습니다. 공정위 가맹정보 API 는 데이터셋별로 경로가 다르므로, " +
          "data.go.kr 활용신청 후 받은 가이드 문서의 요청주소를 ftc.ts 의 ENDPOINTS 에 넣으세요.",
      evidence:
        probe.attempts.map((a) => `${a.endpoint}\n  → ${a.error}`).join("\n") +
        `\n[음성 대조군] ${controlPath}\n  → ${controlError}` +
        (sameAsControl ? "\n  ⇒ 후보들과 응답이 동일하다. 이 상태 코드는 정보를 담고 있지 않다." : ""),
    });
    return { adapter: "ftc_franchise", checks, status: "fail" };
  }

  const working = probe.found;
  checks.push({
    name: "엔드포인트",
    status: working.endpoint === FTC_ENDPOINT_CANDIDATES[0] ? "pass" : "warn",
    detail:
      working.endpoint === FTC_ENDPOINT_CANDIDATES[0]
        ? "코드에 적힌 엔드포인트가 정상 동작합니다."
        : "다른 후보가 동작했습니다. ftc.ts 의 ENDPOINTS.brandList 를 이 값으로 고치세요.",
    evidence: working.endpoint,
  });

  const fixture = recordFixture(fixtureDir, "ftc-brandList", working.body);
  if (fixture) {
    checks.push({ name: "fixture 녹화", status: "pass", detail: "회귀 테스트 입력으로 저장했습니다.", evidence: fixture });
  }

  const items = (working.parsed?.items ?? []) as FtcBrandItem[];
  if (items.length === 0) {
    checks.push({ name: "응답 항목", status: "fail", detail: "항목이 0건입니다.", evidence: `totalCount=${working.parsed?.totalCount ?? "?"}` });
    return { adapter: "ftc_franchise", workingEndpoint: working.endpoint, checks, status: "fail" };
  }

  const keys = [...new Set(items.flatMap((i) => Object.keys(i)))];
  const hasId = items.some((i) => i.brandMgtNo);
  const hasName = items.some((i) => i.brandNm || i.jnghdqrtrsNm);

  checks.push({
    name: "필수 필드",
    status: hasId && hasName ? "pass" : "fail",
    detail:
      hasId && hasName
        ? "brandMgtNo 와 브랜드/본부명이 존재합니다. mapFtcBrand 가 동작합니다."
        : "식별자 또는 이름 필드명이 다릅니다. ftc.ts 의 FtcBrandItem 을 실제 응답에 맞추세요.",
    evidence: `관찰된 키: ${keys.join(", ")}`,
  });

  checks.push({
    name: "개인정보 필드",
    status: keys.includes("reprsntNm") ? "warn" : "pass",
    detail: keys.includes("reprsntNm")
      ? "응답에 대표자명이 포함됩니다. mapFtcBrand 가 후보에 담지 않는지 테스트로 보장됩니다."
      : "응답에 대표자명이 없습니다.",
  });

  return { adapter: "ftc_franchise", workingEndpoint: working.endpoint, checks, status: worstStatus(checks) };
}

/**
 * 표본 요양기관들의 진료과목을 조회해 **코드 → 이름** 표를 만든다.
 *
 * 이것이 되면 이름 기반 휴리스틱은 필요 없다. 접근 권한이 없으면 빈 표를 돌려준다.
 */
async function fetchDgsbjtCodeTable(
  http: HttpClient,
  serviceKey: string,
  logger: Logger,
  sample: readonly HiraHospitalItem[],
): Promise<Map<string, string>> {
  const table = new Map<string, string>();
  const ykihos = sample.map((s) => s.ykiho).filter((y): y is string => Boolean(y)).slice(0, 12);
  if (ykihos.length === 0) return table;

  let endpoint: string | undefined;
  for (const ykiho of ykihos) {
    const candidates = endpoint ? [endpoint] : HIRA_DGSBJT_ENDPOINT_CANDIDATES;
    const p = await probeEndpoints(http, serviceKey, candidates, { ykiho, pageNo: 1, numOfRows: 50 }, logger);
    if (!p.found) {
      if (!endpoint) return table; // 첫 시도부터 실패 = 접근 권한 없음
      continue;
    }
    endpoint = p.found.endpoint;
    for (const raw of p.found.parsed?.items ?? []) {
      const item = raw as DgsbjtItem;
      if (item.dgsbjtCd && item.dgsbjtCdNm) {
        table.set(String(item.dgsbjtCd).padStart(2, "0"), item.dgsbjtCdNm.trim());
      }
    }
    // 충분히 모였으면 그만 둔다 (상대 서버 부담을 줄인다).
    if (table.size >= 20) break;
  }
  return table;
}

function fmtLift(lift: number): string {
  if (!Number.isFinite(lift)) return "∞";
  return lift.toFixed(1);
}

function worstStatus(checks: readonly CheckResult[]): CheckStatus {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "pass";
}

export async function verifyAdapters(options: VerifyOptions): Promise<AdapterVerification[]> {
  return [await verifyHira(options), await verifyFtc(options)];
}

/** 리포트를 사람이 읽을 형태로. */
export function formatVerification(results: readonly AdapterVerification[]): string {
  const icon: Record<CheckStatus, string> = { pass: "✓", fail: "✗", warn: "!", skip: "-" };
  const lines: string[] = [""];

  for (const r of results) {
    lines.push(`■ ${r.adapter}  [${icon[r.status]} ${r.status.toUpperCase()}]`);
    if (r.workingEndpoint) lines.push(`  동작 엔드포인트: ${redactUrl(r.workingEndpoint)}`);
    lines.push("");
    for (const c of r.checks) {
      lines.push(`  ${icon[c.status]} ${c.name}`);
      lines.push(`      ${c.detail}`);
      if (c.evidence) {
        for (const line of c.evidence.split("\n")) lines.push(`      ${line}`);
      }
      lines.push("");
    }
  }

  const failed = results.filter((r) => r.status === "fail");
  if (failed.length === 0) {
    lines.push("모든 어댑터가 실 API 로 검증됐습니다.");
    lines.push("→ 각 어댑터의 `verifiedAgainstLiveApi` 를 true 로 바꾸고 fixture 테스트를 추가하세요.");
  } else {
    lines.push(`검증 실패: ${failed.map((f) => f.adapter).join(", ")}`);
    lines.push("→ 위 진단대로 엔드포인트·필드명·코드값을 고친 뒤 다시 실행하세요.");
    lines.push("→ `verifiedAgainstLiveApi` 는 false 로 두세요. 그래야 스파이크가 계속 경고합니다.");
  }
  lines.push("");
  return lines.join("\n");
}
