import { describe, expect, it } from "vitest";
import { assertNoPII, redactPII, redactString, redactUrl } from "./redact";

describe("redactUrl — 비밀값이 로그·에러에 남지 않게 한다", () => {
  it("공공데이터포털 serviceKey 를 지운다", () => {
    const out = redactUrl("https://apis.data.go.kr/x/y?serviceKey=SECRET123&pageNo=1");
    expect(out).not.toContain("SECRET123");
    expect(out).toContain("pageNo=1");
  });

  it("대소문자를 가리지 않는다", () => {
    expect(redactUrl("https://a.kr/?ServiceKey=S1&APIKEY=S2")).not.toMatch(/S1|S2/);
  });

  it("토큰·시크릿류 파라미터를 함께 지운다", () => {
    const out = redactUrl("https://a.kr/?access_token=T&client_secret=C&signature=G&safe=1");
    expect(out).not.toMatch(/[=]T\b|[=]C\b|[=]G\b/);
    expect(out).toContain("safe=1");
  });

  it("URL 의 userinfo 를 제거한다", () => {
    expect(redactUrl("https://user:pw@a.kr/x")).toBe("https://a.kr/x");
  });

  it("URL 이 아니면 문자열 마스킹으로 폴백한다", () => {
    expect(redactUrl("연락처 a@b.kr")).toBe("연락처 [redacted]");
  });

  it("민감 값이 없으면 그대로 둔다", () => {
    expect(redactUrl("https://a.kr/x?pageNo=2")).toBe("https://a.kr/x?pageNo=2");
  });
});

describe("redactString", () => {
  it("이메일 주소를 마스킹한다", () => {
    expect(redactString("문의: contact@clinic.co.kr 로 주세요")).toBe("문의: [redacted] 로 주세요");
  });

  it("점·플러스가 포함된 로컬파트도 마스킹한다", () => {
    expect(redactString("kim.min+ads@example.com")).toBe("[redacted]");
  });

  it("한 문자열 안의 여러 이메일을 전부 마스킹한다", () => {
    expect(redactString("a@b.co, c@d.kr")).toBe("[redacted], [redacted]");
  });

  it("한국 전화번호를 마스킹한다", () => {
    expect(redactString("02-1234-5678")).toBe("[redacted]");
    expect(redactString("010-9876-5432")).toBe("[redacted]");
  });

  it("주민등록번호 형태를 마스킹한다", () => {
    expect(redactString("900101-1234567")).toBe("[redacted]");
  });

  it("국제 표기 전화번호도 마스킹한다", () => {
    expect(redactString("+82-10-1234-5678")).toBe("[redacted]");
    expect(redactString("+82 2 1234 5678")).toBe("[redacted]");
  });

  it("PII 가 없는 문자열은 그대로 둔다", () => {
    expect(redactString("강남 피부과 최근 60일 콘텐츠 0건")).toBe("강남 피부과 최근 60일 콘텐츠 0건");
  });
});

describe("redactPII", () => {
  it("PII 키의 값 전체를 지운다", () => {
    const out = redactPII({ companyName: "강남피부과", email: "info@gangnam.kr", score: 72 });
    expect(out).toEqual({ companyName: "강남피부과", email: "[redacted]", score: 72 });
  });

  it("중첩 객체와 배열을 재귀적으로 처리한다", () => {
    const out = redactPII({
      company: { name: "테스트치과", contacts: [{ address: "a@b.kr" }, { address: "c@d.kr" }] },
      note: "대표 메일은 owner@test.kr 입니다",
    });
    expect(out).toEqual({
      company: { name: "테스트치과", contacts: [{ address: "[redacted]" }, { address: "[redacted]" }] },
      note: "대표 메일은 [redacted] 입니다",
    });
  });

  it("순환 참조를 끊는다", () => {
    const a: Record<string, unknown> = { name: "x" };
    a["self"] = a;
    expect(redactPII(a)).toEqual({ name: "x", self: "[circular]" });
  });

  it("Error 의 message 도 마스킹한다", () => {
    const out = redactPII({ err: new Error("send to admin@x.kr failed") }) as { err: { message: string } };
    expect(out.err.message).toBe("send to [redacted] failed");
  });

  it("Date 는 ISO 문자열로 직렬화한다", () => {
    const out = redactPII({ at: new Date("2026-07-29T00:00:00Z") });
    expect(out).toEqual({ at: "2026-07-29T00:00:00.000Z" });
  });

  it("Map 의 값도 마스킹한다 (Object.entries 로는 통째로 사라짐)", () => {
    const m = new Map<string, unknown>([
      ["note", "문의 owner@clinic.kr"],
      ["email", "ceo@clinic.kr"],
    ]);
    expect(redactPII({ m })).toEqual({ m: { note: "문의 [redacted]", email: "[redacted]" } });
  });

  it("Set 의 값도 마스킹한다", () => {
    expect(redactPII({ s: new Set(["a@b.kr", "정상"]) })).toEqual({ s: ["[redacted]", "정상"] });
  });

  it("Buffer 는 인덱스 객체로 펼치지 않고 크기만 남긴다", () => {
    const out = redactPII({ buf: Buffer.from("info@clinic.kr", "utf8") }) as unknown as { buf: string };
    expect(out.buf).toMatch(/^\[binary \d+B\]$/);
    expect(out.buf).not.toContain("@");
  });

  it("던지는 getter 때문에 마스킹 전체가 실패하지 않는다", () => {
    const obj = { safe: "ok" };
    Object.defineProperty(obj, "boom", {
      enumerable: true,
      get() {
        throw new Error("접근 불가");
      },
    });
    expect(redactPII(obj)).toEqual({ safe: "ok", boom: "[getter-threw]" });
  });

  it("prototype 없는 객체도 처리한다", () => {
    const o = Object.create(null) as Record<string, unknown>;
    o["email"] = "x@y.kr";
    expect(redactPII(o)).toEqual({ email: "[redacted]" });
  });

  it("전역 정규식의 lastIndex 가 호출 간에 새지 않는다", () => {
    const input = "a@b.kr 그리고 c@d.kr";
    expect(redactString(input)).toBe(redactString(input));
    expect(redactString(input)).toBe("[redacted] 그리고 [redacted]");
  });

  it("마스킹 결과에는 이메일이 남지 않는다 (LLM 전송 경계 계약)", () => {
    const payload = {
      weaknesses: [{ code: "no_recent_content", evidence: { lastPost: "2025-01-02" } }],
      contact: { address: "marketing@clinic.co.kr", email_address: "ceo@clinic.co.kr" },
      freeText: "문의는 help@clinic.co.kr",
    };
    const serialized = JSON.stringify(redactPII(payload));
    expect(() => assertNoPII(serialized, "llm.prompt")).not.toThrow();
  });
});

describe("assertNoPII", () => {
  it("마스킹되지 않은 이메일이 있으면 던진다", () => {
    expect(() => assertNoPII(JSON.stringify({ note: "leak@x.kr" }), "test")).toThrow(/email/);
  });

  it("전화번호도 검사한다", () => {
    expect(() => assertNoPII(JSON.stringify({ tel: "010-1234-5678" }), "test")).toThrow(/phone/);
    expect(() => assertNoPII(JSON.stringify({ tel: "+82-10-1234-5678" }), "test")).toThrow(/phone/);
  });

  it("주민번호도 검사한다", () => {
    expect(() => assertNoPII(JSON.stringify({ x: "900101-1234567" }), "test")).toThrow(/rrn/);
  });

  it("깨끗한 문자열은 통과시킨다", () => {
    expect(() => assertNoPII(JSON.stringify({ note: "[redacted]" }), "test")).not.toThrow();
  });

  it("연속 호출에서 정규식 상태가 새지 않는다", () => {
    const dirty = JSON.stringify({ a: "x@y.kr", b: "z@w.kr" });
    expect(() => assertNoPII(dirty, "1")).toThrow();
    expect(() => assertNoPII(dirty, "2")).toThrow();
    expect(() => assertNoPII(dirty, "3")).toThrow();
  });
});
