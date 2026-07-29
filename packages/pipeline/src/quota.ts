import { configError } from "@leadops/core";
import type { Sql, TransactionSql } from "postgres";

/**
 * 외부 API 일일 쿼터 가드 (설계서 4.1 · R2-06).
 *
 * **선점(reserve) 방식이다.** 호출한 뒤에 세지 않고, 호출하기 전에 원장에 먼저 적는다.
 * 워커가 호출 직후 죽으면 "썼는데 세지 않은" 호출이 생기고, 그 상태로 재시도하면
 * 실제 사용량이 한도를 넘는다. 과다 계상은 하루치 여유를 조금 잃을 뿐이지만
 * 과소 계상은 계정 차단으로 이어진다. 안전한 쪽으로 틀린다.
 *
 * 멱등성: `cost_ledger.entry_key` 가 unique 이므로 같은 키로 다시 선점해도 이중 계상되지
 * 않는다(F-16). 잡 재시도가 쿼터를 갉아먹지 않는다.
 *
 * 동시성: 같은 provider 에 대해 트랜잭션 advisory lock 을 잡는다. 두 워커가 동시에
 * 한도 직전에서 검사하면 둘 다 통과해 버리기 때문이다.
 */

/** 하루 경계는 KST 기준이다 (설계서 schedule.timezone = Asia/Seoul). */
const TZ = "Asia/Seoul";

export interface QuotaSpec {
  /** `cost_ledger.provider` 에 그대로 들어간다. */
  readonly provider: string;
  /** 하루에 쓸 수 있는 단위 수. */
  readonly dailyCap: number;
  /** 단위 이름 (`call` · `unit`). 리포트용. */
  readonly unit: string;
  /** 단위당 원가. 무료 API 는 0. */
  readonly krwPerUnit?: number;
}

export interface ReserveResult {
  readonly granted: boolean;
  /** 선점 후 오늘 누적 사용량. */
  readonly used: number;
  readonly cap: number;
  /** 이미 같은 키로 선점돼 있었다 (잡 재시도). */
  readonly replayed: boolean;
}

export class QuotaGuard {
  readonly #sql: Sql;
  readonly #runId: string | null;
  readonly #spec: QuotaSpec;

  constructor(sql: Sql, runId: string | null, spec: QuotaSpec) {
    if (!Number.isFinite(spec.dailyCap) || spec.dailyCap < 0) {
      throw configError(`${spec.provider} 일일 한도가 올바르지 않습니다`, { dailyCap: spec.dailyCap });
    }
    this.#sql = sql;
    this.#runId = runId;
    this.#spec = spec;
  }

  get provider(): string {
    return this.#spec.provider;
  }

  /** 오늘 이 provider 로 선점된 총량. */
  async usedToday(): Promise<number> {
    const [row] = await this.#sql<Array<{ used: string }>>`
      select coalesce(sum(qty), 0)::text as used
      from cost_ledger
      where provider = ${this.#spec.provider}
        and created_at >= (date_trunc('day', now() at time zone ${TZ}) at time zone ${TZ})
    `;
    return Number(row?.used ?? 0);
  }

  /**
   * 호출 전에 `units` 만큼 선점한다.
   *
   * 한도를 넘으면 **던지지 않고** `granted: false` 를 돌려준다. 쿼터 소진은 오류가 아니라
   * 예정된 운영 상태이고, 스테이지는 여기서 멈춘 뒤 실행을 `partial` 로 끝내야 하기 때문이다
   * (설계서 4.1). 조용히 넘어가지 않도록 호출자가 반드시 세어서 기록한다.
   *
   * @param entryKey 멱등 키. 같은 작업 단위는 항상 같은 키여야 한다.
   */
  async reserve(units: number, entryKey: string): Promise<ReserveResult> {
    if (units <= 0) throw configError("선점 단위는 1 이상이어야 합니다", { units });

    return this.#sql.begin(async (tx) => {
      // 한도 직전 동시 선점을 직렬화한다.
      await tx`select pg_advisory_xact_lock(hashtext(${this.#spec.provider}))`;

      const [existing] = await tx<Array<{ qty: string }>>`
        select qty::text from cost_ledger where entry_key = ${entryKey}
      `;
      if (existing) {
        // 재시도다. 이미 센 몫이므로 다시 세지 않는다.
        return { granted: true, used: await this.#usedIn(tx), cap: this.#spec.dailyCap, replayed: true };
      }

      const used = await this.#usedIn(tx);
      if (used + units > this.#spec.dailyCap) {
        return { granted: false, used, cap: this.#spec.dailyCap, replayed: false };
      }

      const krw = (this.#spec.krwPerUnit ?? 0) * units;
      await tx`
        insert into cost_ledger (run_id, entry_key, provider, unit, qty, krw)
        values (${this.#runId}, ${entryKey}, ${this.#spec.provider}, ${this.#spec.unit}, ${units}, ${krw})
      `;
      return { granted: true, used: used + units, cap: this.#spec.dailyCap, replayed: false };
    }) as Promise<ReserveResult>;
  }

  async #usedIn(tx: Sql | TransactionSql): Promise<number> {
    const [row] = await tx<Array<{ used: string }>>`
      select coalesce(sum(qty), 0)::text as used
      from cost_ledger
      where provider = ${this.#spec.provider}
        and created_at >= (date_trunc('day', now() at time zone ${TZ}) at time zone ${TZ})
    `;
    return Number(row?.used ?? 0);
  }
}

/** 설정 스냅샷의 `quota` 섹션. 없거나 범위를 벗어나면 통과가 아니라 에러다. */
export interface QuotaSettings {
  readonly naverDailyCap: number;
  readonly dataGoKrDailyCap: number;
  readonly youtubeDailyUnits: number;
}

export function quotaSettingsFrom(settings: Record<string, unknown>): QuotaSettings {
  const raw = settings["quota"];
  if (raw === null || typeof raw !== "object") {
    throw configError("설정에 quota 섹션이 없습니다", { keys: Object.keys(settings) });
  }
  const section = raw as Record<string, unknown>;

  const read = (key: string): number => {
    const value = section[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw configError(`quota.${key} 가 올바르지 않습니다`, { key, value });
    }
    return value;
  };

  return {
    naverDailyCap: read("naver_daily_cap"),
    dataGoKrDailyCap: read("data_go_kr_daily_cap"),
    youtubeDailyUnits: read("youtube_daily_units"),
  };
}
