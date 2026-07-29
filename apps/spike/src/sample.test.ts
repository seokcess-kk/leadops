import { makeMockCandidate } from "@leadops/adapters";
import type { RawCandidate } from "@leadops/core";
import { describe, expect, it } from "vitest";
import { flagNumber, flagString, parseArgs, renderTable } from "./cli";
import { csvCell, mulberry32, shuffle, stratifiedSample } from "./sample";

describe("parseArgs", () => {
  it("명령과 --flag value 를 읽는다", () => {
    const a = parseArgs(["sample", "--per-industry", "30", "--seed", "42"]);
    expect(a.command).toBe("sample");
    expect(flagNumber(a, "per-industry")).toBe(30);
    expect(flagNumber(a, "seed")).toBe(42);
  });

  it("--flag=value 형태를 읽는다", () => {
    expect(flagString(parseArgs(["u", "--industry=dental"]), "industry")).toBe("dental");
  });

  it("값 없는 플래그는 true 로 둔다", () => {
    expect(parseArgs(["u", "--verbose"]).flags["verbose"]).toBe(true);
    expect(parseArgs(["u", "--verbose", "--seed", "1"]).flags["verbose"]).toBe(true);
  });

  it("숫자가 아닌 값을 숫자 플래그로 읽으면 던진다", () => {
    expect(() => flagNumber(parseArgs(["u", "--seed", "abc"]), "seed")).toThrowError(/숫자여야/);
  });
});

describe("mulberry32 / shuffle — 재현성", () => {
  it("같은 시드는 같은 수열을 만든다", () => {
    const a = Array.from({ length: 5 }, mulberry32(42));
    const b = Array.from({ length: 5 }, mulberry32(42));
    expect(a).toEqual(b);
  });

  it("다른 시드는 다른 수열을 만든다", () => {
    expect(Array.from({ length: 5 }, mulberry32(1))).not.toEqual(Array.from({ length: 5 }, mulberry32(2)));
  });

  it("shuffle 은 원소를 잃지 않는다", () => {
    const input = [1, 2, 3, 4, 5, 6, 7];
    const out = shuffle(input, mulberry32(7));
    expect([...out].sort()).toEqual(input);
  });

  it("shuffle 은 입력 배열을 바꾸지 않는다", () => {
    const input = [1, 2, 3];
    shuffle(input, mulberry32(1));
    expect(input).toEqual([1, 2, 3]);
  });
});

describe("stratifiedSample", () => {
  /** 지역 분포를 통제한 후보 풀을 만든다. */
  const pool = (counts: { seoul: number; metro: number; other: number }): RawCandidate[] => {
    const out: RawCandidate[] = [];
    let i = 0;
    const push = (sido: string, n: number): void => {
      for (let k = 0; k < n; k++, i++) {
        out.push({ ...makeMockCandidate("derm", i), externalId: `id-${i}`, regionSido: sido });
      }
    };
    push("서울특별시", counts.seoul);
    push("부산광역시", counts.metro);
    push("경기도", counts.other);
    return out;
  };

  it("층별 할당량대로 뽑는다", () => {
    const r = stratifiedSample(pool({ seoul: 50, metro: 50, other: 50 }), mulberry32(1));
    expect(r.perStratum).toEqual({ 서울: 15, 광역시: 8, "그 외": 7 });
    expect(r.picked).toHaveLength(30);
    expect(r.shortfall).toEqual({});
  });

  it("같은 후보를 두 층에 중복해서 넣지 않는다", () => {
    const r = stratifiedSample(pool({ seoul: 50, metro: 50, other: 50 }), mulberry32(1));
    expect(new Set(r.picked.map((c) => c.externalId)).size).toBe(r.picked.length);
  });

  it("❗ 층 할당량을 못 채우면 다른 층에서 메우지 않고 부족분을 보고한다", () => {
    const r = stratifiedSample(pool({ seoul: 3, metro: 50, other: 50 }), mulberry32(1));
    expect(r.perStratum["서울"]).toBe(3);
    expect(r.shortfall["서울"]).toBe(12);
    expect(r.picked).toHaveLength(3 + 8 + 7); // 총 30 이 아니라 18
  });

  it("'그 외' 층은 앞 층에서 이미 쓰인 후보를 다시 쓰지 않는다", () => {
    // 전부 서울이면 서울 15 를 먼저 채우고, '그 외'(전체 매칭)는 남은 것에서 7 을 채운다.
    const r = stratifiedSample(pool({ seoul: 30, metro: 0, other: 0 }), mulberry32(3));
    expect(r.perStratum["서울"]).toBe(15);
    expect(r.perStratum["광역시"]).toBe(0);
    expect(r.perStratum["그 외"]).toBe(7);
    expect(new Set(r.picked.map((c) => c.externalId)).size).toBe(22);
  });

  it("같은 시드로 재실행하면 같은 표본이 나온다", () => {
    const p = pool({ seoul: 50, metro: 50, other: 50 });
    const a = stratifiedSample(p, mulberry32(99)).picked.map((c) => c.externalId);
    const b = stratifiedSample(p, mulberry32(99)).picked.map((c) => c.externalId);
    expect(a).toEqual(b);
  });

  it("빈 풀에서도 죽지 않는다", () => {
    const r = stratifiedSample([], mulberry32(1));
    expect(r.picked).toEqual([]);
    expect(r.shortfall).toEqual({ 서울: 15, 광역시: 8, "그 외": 7 });
  });
});

describe("csvCell", () => {
  it("쉼표·따옴표·줄바꿈을 이스케이프한다", () => {
    expect(csvCell("서울, 강남")).toBe('"서울, 강남"');
    expect(csvCell('그는 "의사"다')).toBe('"그는 ""의사""다"');
    expect(csvCell("줄1\n줄2")).toBe('"줄1\n줄2"');
  });
  it("일반 문자열은 그대로 둔다", () => {
    expect(csvCell("강남피부과")).toBe("강남피부과");
  });
});

describe("renderTable", () => {
  it("한글 폭을 고려해 정렬한다", () => {
    const out = renderTable(["업종", "수"], [["피부과", "1450"], ["치과", "19300"]]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(4);
    // 헤더 구분선의 첫 열 폭이 가장 긴 값("피부과" = 6칸)과 같아야 한다
    expect(lines[1]!.split("  ")[0]).toBe("─".repeat(6));
  });
});
