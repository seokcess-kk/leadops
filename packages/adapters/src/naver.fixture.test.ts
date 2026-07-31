import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ORS_CHANNELS, parseNaverResponse } from "./search";

/**
 * 네이버 검색 회귀 — **실제 API 응답**으로 파서를 검증한다.
 *
 * `fixtures/http/naver-search-*.json` 은 `pnpm spike verify` 가 실키로 받아 녹화한
 * 진짜 응답이다 (2026-07-31). 네이버가 필드명·형태를 바꾸면 여기서 깨진다 —
 * 그것이 이 테스트의 목적이다. (hira.fixture.test.ts 와 같은 방식)
 */

const FIXTURES = fileURLToPath(new URL("../../../fixtures/http/", import.meta.url));
const load = (name: string): string => readFileSync(join(FIXTURES, `${name}.json`), "utf8");

describe("네이버 검색 회귀 — 실응답 fixture (2026-07-31 녹화)", () => {
  for (const channel of ORS_CHANNELS) {
    it(`${channel}: 파서가 실응답을 해석한다`, () => {
      const result = parseNaverResponse(channel, "강남 피부과", load(`naver-search-${channel}`));
      expect(result.total).toBeGreaterThan(0);
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.hits[0]!.link).toMatch(/^https?:/);
    });
  }

  it("blog 응답에 발행일이 있다 (postdate — 활동성·최신성 신호의 근거)", () => {
    const result = parseNaverResponse("blog", "강남 피부과", load("naver-search-blog"));
    expect(result.hits.some((h) => h.publishedAt instanceof Date)).toBe(true);
  });
});
