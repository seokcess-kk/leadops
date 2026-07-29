import { configError, type Logger } from "@leadops/core";
import type { SourceAdapter } from "@leadops/adapters";
import type { HttpClient, RobotsGate } from "@leadops/http";
import type { Sql } from "postgres";

/**
 * 스테이지 계약 (설계서 5.3 DAG).
 *
 * 모든 스테이지는 **멱등**해야 한다. 잡이 재시도되거나 lease 만료로 다시 실행돼도
 * 같은 결과가 나와야 한다. 그래서 모든 쓰기는 upsert 이고, 처리 완료 표시를
 * 결과와 같은 트랜잭션에 넣는다.
 */

export interface StageContext {
  sql: Sql;
  runId: string;
  attemptId: string;
  /** 실행 시작 시점에 동결된 설정. 실행 중 설정이 바뀌어도 영향받지 않는다. */
  settings: Record<string, unknown>;
  logger: Logger;
  adapters: readonly SourceAdapter[];
  /**
   * 외부 사이트를 직접 가져오는 스테이지에만 필요하다 (홈페이지 판별부터).
   * 수집·정규화·제외는 쓰지 않으므로 선택 항목이다.
   */
  http?: HttpClient | undefined;
  /** robots.txt 게이트. `http` 를 쓰는 스테이지는 반드시 함께 받아야 한다. */
  robots?: RobotsGate | undefined;
}

/** `http`·`robots` 가 준비된 컨텍스트. 없으면 스테이지를 시작하지 않는다. */
export interface FetchingStageContext extends StageContext {
  http: HttpClient;
  robots: RobotsGate;
}

export interface StageResult {
  /** 처리한 항목 수. 진행 표시에 쓴다. */
  processed: number;
  /** 다음 스테이지로 넘어간 항목 수. */
  passed: number;
  /** 건너뛴 항목과 사유. 조용한 누락을 막는다. */
  skipped: Record<string, number>;
  /** 사람이 읽을 요약. */
  note?: string;
}

export interface StageHandler {
  readonly stage: string;
  /** 이 스테이지가 실행되려면 먼저 terminal 이어야 하는 스테이지들. */
  readonly dependsOn: readonly string[];
  run(ctx: StageContext, payload: Record<string, unknown>): Promise<StageResult>;
}

/**
 * 외부 fetch 가 필요한 스테이지의 진입 가드.
 *
 * 조용히 건너뛰지 않고 던진다 — HTTP 계층 없이 홈페이지를 판별했다고 기록하면
 * 그 결과가 "판별했으나 아무 신호도 없음" 과 구분되지 않는다.
 */
export function requireFetching(ctx: StageContext, stage: string): FetchingStageContext {
  if (!ctx.http || !ctx.robots) {
    throw configError(`${stage} 스테이지에는 HttpClient 와 RobotsGate 가 필요합니다`, {
      stage,
      hasHttp: Boolean(ctx.http),
      hasRobots: Boolean(ctx.robots),
    });
  }
  return ctx as FetchingStageContext;
}

export const emptyResult = (): StageResult => ({ processed: 0, passed: 0, skipped: {} });

export function countSkip(result: StageResult, reason: string): void {
  result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
}
