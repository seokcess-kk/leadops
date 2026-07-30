import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { STATE_FILE, type E2EState } from "./env";

/** 저장소 루트. `apps/e2e/src` 에서 두 단계 위. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const TAIMEN_DIR = resolve(REPO_ROOT, "taimen");

export function writeState(state: E2EState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

export function readState(): E2EState {
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as E2EState;
}

export function clearState(): void {
  rmSync(STATE_FILE, { force: true });
}

export interface Managed {
  child: ChildProcess;
  /** 마지막 출력. 기동 실패 원인을 에러 메시지에 함께 담기 위해 보관한다. */
  tail: () => string;
}

/**
 * 자식 프로세스를 띄우고 출력을 모은다.
 *
 * ❗ Windows 에서 `pnpm` 은 `.cmd` 라 `shell: true` 가 필요하고, 그러면 자식이 손자를
 *    만든다 (`pnpm` → `node`). 그래서 종료는 PID 하나가 아니라 **트리 전체**를 죽인다.
 */
export function launch(command: string, args: string[], cwd: string, env: Record<string, string>): Managed {
  const child = spawn(command, args, {
    cwd,
    shell: true,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const lines: string[] = [];
  const collect = (chunk: Buffer): void => {
    lines.push(chunk.toString("utf8"));
    // 마지막 40 조각만 남긴다 — 실패 원인은 거의 항상 끝에 있다.
    if (lines.length > 40) lines.splice(0, lines.length - 40);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  return { child, tail: () => lines.join("") };
}

/** 프로세스 트리를 죽인다. 남으면 다음 실행이 포트를 못 잡는다. */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // 이미 죽었다.
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * URL 이 200 을 줄 때까지 기다린다.
 *
 * ❗ 타임아웃 메시지에 자식 프로세스 출력을 붙인다. 이것이 없으면 "기동 실패" 만 남고,
 *    실제 원인(예: `Another next dev server is already running`)을 찾을 수 없다.
 */
export async function waitForHttp(
  url: string,
  label: string,
  managed: Managed,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (managed.child.exitCode !== null) {
      throw new Error(
        `${label} 이 기동 전에 종료되었습니다 (exit ${managed.child.exitCode}).\n--- 출력 ---\n${managed.tail()}`,
      );
    }
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(500);
  }
  throw new Error(
    `${label} 이 ${timeoutMs}ms 안에 응답하지 않았습니다 (${url}, 마지막 오류: ${lastError}).\n` +
      `--- 출력 ---\n${managed.tail()}`,
  );
}
