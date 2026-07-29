import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 정책 회귀 테스트 — 설계서 Phase 3 완료 기준.
 *
 *   "이메일 추출 코드가 존재하지 않음을 증명하는 테스트
 *    (packages/ 전체에 이메일 정규식 부재 검사)"
 *
 * 정보통신망법 제50조의2 는 홈페이지 운영자의 사전 동의 없이 **자동으로 이메일을
 * 수집하는 프로그램**을 금지한다. 우리 설계는 이메일을 검수자가 눈으로 보고 직접
 * 입력하는 것으로 바꿨다(설계서 결론 A).
 *
 * 그 결정은 문서에만 있으면 언제든 되돌아간다. 누군가 "편의를 위해" 파서를
 * 추가하는 것을 막기 위해, 소스에 이메일 추출 정규식이 생기면 빌드를 깨뜨린다.
 *
 * 허용 목록에 파일을 추가하려면 **왜 그것이 수집이 아닌지**를 여기에 적어야 한다.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCAN_DIRS = ["packages", "apps"];

/**
 * 이메일 추출로 볼 만한 정규식 패턴.
 *
 * `@` 앞뒤로 문자 클래스나 와일드카드가 있는 형태를 찾는다.
 * 단순 문자열 리터럴("info@example.com")은 잡지 않는다 — 그것은 추출이 아니다.
 */
const EMAIL_EXTRACTION_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\[[^\]\n]*\]\s*[+*]?\s*@/, label: "문자클래스 + @" },
  { re: /@\s*\[[^\]\n]*\]/, label: "@ + 문자클래스" },
  { re: /\\w[+*][^\n]{0,20}@/, label: "\\w 반복 + @" },
  { re: /mailto:\s*\(\?/, label: "mailto 캡처그룹" },
];

/**
 * 허용 목록. 각 항목에 사유를 남긴다.
 *
 * ❗ 여기에 파일을 추가하는 것은 법적 판단이다. 가볍게 하지 말 것.
 */
const ALLOWLIST: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: "packages/core/src/redact.ts",
    reason:
      "이메일을 **지우기 위한** 정규식. 수집이 아니라 마스킹이며, " +
      "해외 LLM·로그로 PII 가 나가는 것을 막는 반대 방향의 장치다.",
  },
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

function toRepoPath(abs: string): string {
  return relative(REPO_ROOT, abs).split(sep).join("/");
}

describe("정책: 홈페이지 이메일 자동 추출 코드가 존재하지 않는다", () => {
  const files = SCAN_DIRS.flatMap((d) => listSourceFiles(join(REPO_ROOT, d)));

  it("스캔 대상 파일이 실제로 존재한다 (테스트가 무의미해지는 것 방지)", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("❗ 허용 목록 밖에 이메일 추출 정규식이 없다", () => {
    const allowed = new Set(ALLOWLIST.map((a) => a.path));
    const violations: Array<{ file: string; pattern: string; line: number; text: string }> = [];

    for (const file of files) {
      const repoPath = toRepoPath(file);
      if (allowed.has(repoPath)) continue;

      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((text, i) => {
        for (const { re, label } of EMAIL_EXTRACTION_PATTERNS) {
          if (re.test(text)) {
            violations.push({ file: repoPath, pattern: label, line: i + 1, text: text.trim().slice(0, 120) });
          }
        }
      });
    }

    expect(
      violations,
      violations.length === 0
        ? ""
        : "이메일 추출로 보이는 코드가 발견되었습니다. 정보통신망법 제50조의2 위반 소지가 있습니다.\n" +
            "정당한 사유가 있다면 policy.test.ts 의 ALLOWLIST 에 사유와 함께 추가하세요.\n" +
            violations.map((v) => `  ${v.file}:${v.line} [${v.pattern}] ${v.text}`).join("\n"),
    ).toEqual([]);
  });

  it("허용 목록의 파일은 실제로 존재한다 (죽은 예외 방지)", () => {
    for (const entry of ALLOWLIST) {
      expect(() => statSync(join(REPO_ROOT, entry.path)), `${entry.path} 가 없습니다`).not.toThrow();
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  it("탐지기 자체가 동작한다 (자기 검증)", () => {
    const bait = String.raw`const RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g;`;
    const hit = EMAIL_EXTRACTION_PATTERNS.some(({ re }) => re.test(bait));
    expect(hit, "탐지 규칙이 명백한 이메일 추출 정규식을 놓쳤습니다").toBe(true);
  });
});
