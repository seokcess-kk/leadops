import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RawCandidate } from "@leadops/core";
import { describe, expect, it } from "vitest";
import { parseDataGoKrJson } from "./dataGoKr";
import { HIRA_CODES, mapHiraItem, type HiraHospitalItem } from "./hira";

/**
 * HIRA 회귀 테스트 — **실제 API 응답**으로 매핑을 검증한다.
 *
 * `fixtures/http/*.json` 은 `pnpm spike verify` 가 실키로 받아 녹화한 진짜 응답이다
 * (2026-07-30). 손으로 지어낸 JSON 이 아니므로, 포털이 필드명이나 형태를 바꾸면
 * 여기서 깨진다 — 그것이 이 테스트의 목적이다.
 *
 * 설계서 11장: "가짜 응답만으로 완료 처리하지 않는다."
 */

const FIXTURES = fileURLToPath(new URL("../../../fixtures/http/", import.meta.url));

const load = (name: string): string => readFileSync(join(FIXTURES, `${name}.json`), "utf8");

/** 검증 당시 실측한 모집단 크기. 크게 달라지면 필터가 바뀐 것이다. */
const VERIFIED_TOTALS: Record<string, number> = {
  "hira-getHospBasisList-derm": 16_987,
  "hira-getHospBasisList-plastic": 4_883,
  "hira-getHospBasisList-dental": 19_398,
};

describe("녹화된 실응답 파싱", () => {
  for (const name of Object.keys(VERIFIED_TOTALS)) {
    it(`${name} — 봉투를 해석한다`, () => {
      // parseDataGoKrJson 은 resultCode !== '00' 이면 던진다 (fail-open 금지).
      // 여기서 던지지 않는다는 것 자체가 정상 응답이라는 뜻이다.
      const envelope = parseDataGoKrJson<HiraHospitalItem>(load(name), "fixture");
      expect(envelope.items.length).toBeGreaterThan(0);
      expect(envelope.pageNo).toBe(1);
    });

    it(`${name} — 모집단 크기가 검증 당시와 같은 자릿수다`, () => {
      const envelope = parseDataGoKrJson<HiraHospitalItem>(load(name), "fixture");
      const expected = VERIFIED_TOTALS[name]!;
      // 실데이터라 개폐업으로 조금씩 변한다. 필터가 바뀐 수준의 변화만 잡는다.
      expect(envelope.totalCount).toBeGreaterThan(expected * 0.5);
      expect(envelope.totalCount).toBeLessThan(expected * 2);
    });
  }
});

describe("mapHiraItem — 실응답 → RawCandidate", () => {
  it("❗ 모든 항목이 계약을 만족한다", () => {
    for (const [name, industry] of [
      ["hira-getHospBasisList-derm", "derm"],
      ["hira-getHospBasisList-plastic", "plastic"],
      ["hira-getHospBasisList-dental", "dental"],
    ] as const) {
      const envelope = parseDataGoKrJson<HiraHospitalItem>(load(name), "fixture");
      for (const item of envelope.items) {
        const mapped = mapHiraItem(item, industry, "hira_hospital");
        expect(mapped, `${name}: ${item.yadmNm}`).not.toBeNull();
        // 스키마를 통과하지 못하면 collect 스테이지가 invalid_shape 로 버린다.
        expect(() => RawCandidate.parse(mapped)).not.toThrow();
      }
    }
  });

  it("식별자·이름·지역이 채워진다", () => {
    const envelope = parseDataGoKrJson<HiraHospitalItem>(load("hira-getHospBasisList-derm"), "fixture");
    const mapped = envelope.items.map((i) => mapHiraItem(i, "derm", "hira_hospital")!);
    for (const c of mapped) {
      expect(c.externalId).toBeTruthy();
      expect(c.name).toBeTruthy();
      expect(c.regionSido).toBeTruthy();
    }
  });

  it("❗ 이메일 필드가 존재하지 않는다 (제50조의2)", () => {
    // 공공 API 가 이메일을 주지 않는다는 사실도 회귀로 고정한다.
    const envelope = parseDataGoKrJson<HiraHospitalItem>(load("hira-getHospBasisList-derm"), "fixture");
    const keys = new Set(envelope.items.flatMap((i) => Object.keys(i)));
    for (const key of keys) expect(key.toLowerCase()).not.toContain("mail");
  });

  it("응답에 홈페이지 필드가 존재한다 (Phase 3 홈페이지 판별의 입력)", () => {
    // 값이 비어 있는 기관도 많지만, **필드 자체**가 사라지면 판별을 검색으로 해야 한다.
    const raw = load("hira-getHospBasisList-derm") + load("hira-getHospBasisList-dental");
    expect(raw).toContain("hospUrl");
  });
});

describe("검증된 코드값", () => {
  it("❗ 진료과목·종별 코드가 검증 당시 값 그대로다", () => {
    // 이 값들은 2026-07-30 실키 전수 카운트로 확정했다 (피부과 99.9% · 성형외과 99.8%).
    // 바꾸려면 `pnpm spike verify` 를 다시 통과시켜야 한다.
    expect(HIRA_CODES.dgsbjt_derm).toBe("14");
    expect(HIRA_CODES.dgsbjt_plastic).toBe("08");
    expect(HIRA_CODES.cl_dental_clinic).toBe("51");
    expect(HIRA_CODES.cl_clinic).toBe("31");
  });

  it("녹화된 응답의 종별이 요청한 코드와 일치한다", () => {
    const envelope = parseDataGoKrJson<HiraHospitalItem>(load("hira-getHospBasisList-dental"), "fixture");
    for (const item of envelope.items) {
      expect(String(item.clCd)).toBe(HIRA_CODES.cl_dental_clinic);
    }
  });
});
