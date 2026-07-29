/** 아주 작은 인자 파서. 의존성을 늘리지 않기 위해 직접 쓴다. */

export interface ParsedArgs {
  command: string | undefined;
  flags: Readonly<Record<string, string | boolean>>;
  positionals: readonly string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let command: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
    } else if (command === undefined) {
      command = token;
    } else {
      positionals.push(token);
    }
  }

  return { command, flags, positionals };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const v = flagString(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} 은 숫자여야 합니다 (받은 값: ${v})`);
  return n;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true";
}

/** 고정폭 표 출력. 한글 폭을 고려해 문자 단위가 아니라 표시 폭으로 정렬한다. */
export function renderTable(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const widthOf = (s: string): number => {
    let w = 0;
    for (const ch of s) {
      const code = ch.codePointAt(0)!;
      // CJK·한글 영역은 2칸으로 센다.
      w += (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) ||
           (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
           (code >= 0xff00 && code <= 0xff60) ? 2 : 1;
    }
    return w;
  };
  const pad = (s: string, target: number): string => s + " ".repeat(Math.max(0, target - widthOf(s)));

  const widths = headers.map((h, i) =>
    Math.max(widthOf(h), ...rows.map((r) => widthOf(r[i] ?? ""))),
  );

  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => pad(c, widths[i]!)).join("  ").trimEnd();

  return [
    line(headers),
    widths.map((w) => "─".repeat(w)).join("  "),
    ...rows.map((r) => line(r)),
  ].join("\n");
}
