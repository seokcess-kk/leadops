import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { LeadOpsError } from "@leadops/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpClient, type HttpClientOptions } from "./client";
import { loopbackPolicyForTests } from "./ssrf";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let baseUrl: string;
let handler: Handler;

beforeEach(async () => {
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>ok</html>");
  };
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeClient(overrides: Partial<HttpClientOptions> = {}): HttpClient {
  return new HttpClient({
    userAgent: "LeadOpsBot/1.0 (test)",
    perDomainIntervalMs: 0,
    globalConcurrency: 4,
    connectTimeoutMs: 2_000,
    totalTimeoutMs: 5_000,
    maxRetries: 0,
    maxBodyBytes: 1024 * 1024,
    maxRedirects: 3,
    ssrfPolicy: loopbackPolicyForTests(),
    sleep: async () => {},
    ...overrides,
  });
}

describe("HttpClient — 기본 동작", () => {
  it("본문을 읽는다", async () => {
    const res = await makeClient().get(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.body).toBe("<html>ok</html>");
    expect(res.hops).toEqual([{ url: `${baseUrl}/`, ip: "127.0.0.1" }]);
  });

  it("User-Agent 를 보낸다", async () => {
    let seen = "";
    handler = (req, res) => {
      seen = req.headers["user-agent"] ?? "";
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x");
    };
    await makeClient().get(`${baseUrl}/`);
    expect(seen).toBe("LeadOpsBot/1.0 (test)");
  });

  it("gzip 응답을 해제한다", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      res.end(gzipSync(Buffer.from("<html>압축됨</html>", "utf8")));
    };
    const res = await makeClient().get(`${baseUrl}/`);
    expect(res.body).toBe("<html>압축됨</html>");
  });
});

describe("HttpClient — redirect", () => {
  it("redirect 를 따라가고 홉을 기록한다", async () => {
    handler = (req, res) => {
      if (req.url === "/a") {
        res.writeHead(302, { location: "/b" });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("final");
      }
    };
    const res = await makeClient().get(`${baseUrl}/a`);
    expect(res.body).toBe("final");
    expect(res.finalUrl).toBe(`${baseUrl}/b`);
    expect(res.hops).toHaveLength(2);
  });

  it("❗ 사설망으로 향하는 redirect 를 차단한다 (홉별 재검증)", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    };
    await expect(makeClient().get(`${baseUrl}/`)).rejects.toThrowError(/차단된 IP 대역: 169\.254\.169\.254/);
  });

  it("❗ 사설 대역 redirect 는 테스트 정책에서도 막힌다 (loopback 만 완화됨)", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: "http://10.0.0.1/internal" });
      res.end();
    };
    await expect(makeClient().get(`${baseUrl}/`)).rejects.toThrowError(/차단된 IP 대역: 10\.0\.0\.1/);
  });

  it("❗ 다른 scheme 으로의 redirect 를 차단한다", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: "file:///etc/passwd" });
      res.end();
    };
    await expect(makeClient().get(`${baseUrl}/`)).rejects.toThrowError(/허용되지 않은 scheme/);
  });

  it("redirect 홉 상한을 넘으면 중단한다", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: "/loop" });
      res.end();
    };
    await expect(makeClient({ maxRedirects: 2 }).get(`${baseUrl}/loop`)).rejects.toThrowError(/redirect 홉 상한/);
  });
});

describe("HttpClient — 응답 제한", () => {
  it("허용되지 않은 Content-Type 을 거부한다", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end("%PDF-1.4");
    };
    await expect(makeClient().get(`${baseUrl}/`)).rejects.toThrowError(/허용되지 않은 Content-Type: application\/pdf/);
  });

  it("본문이 상한을 넘으면 잘라내고 truncated 를 표시한다", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("A".repeat(50_000));
    };
    const res = await makeClient({ maxBodyBytes: 1000 }).get(`${baseUrl}/`);
    expect(res.body.length).toBe(1000);
    expect(res.truncated).toBe(true);
  });

  it("❗ 상한에 닿으면 상류 스트림을 끊어 남은 본문을 계속 받지 않는다", async () => {
    let written = 0;
    let ended = false;
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      const chunk = "A".repeat(64 * 1024);
      const pump = (): void => {
        while (written < 40 * 1024 * 1024) {
          if (res.destroyed || res.writableEnded) return;
          written += chunk.length;
          if (!res.write(chunk)) {
            res.once("drain", pump);
            return;
          }
        }
        ended = true;
        res.end();
      };
      pump();
    };

    const res = await makeClient({ maxBodyBytes: 8 * 1024 }).get(`${baseUrl}/`);
    expect(res.truncated).toBe(true);
    expect(res.body.length).toBe(8 * 1024);
    // 40MB 를 다 흘려보내기 전에 끊겼어야 한다.
    expect(ended).toBe(false);
    expect(written).toBeLessThan(40 * 1024 * 1024);
  });

  it("❗ 압축 폭탄을 해제 후 크기로 잘라낸다", async () => {
    // 10MB 를 gzip 하면 수십 KB 지만, 해제 후 상한에서 잘려야 한다.
    const bomb = gzipSync(Buffer.alloc(10 * 1024 * 1024, 0x41));
    expect(bomb.length).toBeLessThan(100_000);
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
      res.end(bomb);
    };
    const res = await makeClient({ maxBodyBytes: 4096 }).get(`${baseUrl}/`);
    expect(res.body.length).toBe(4096);
    expect(res.truncated).toBe(true);
  });
});

describe("HttpClient — 상태 코드와 재시도", () => {
  it("404 를 not_found 에러로 올린다", async () => {
    handler = (_req, res) => {
      res.writeHead(404);
      res.end();
    };
    await expect(makeClient().get(`${baseUrl}/`)).rejects.toMatchObject({ code: "not_found" });
  });

  it("allowNotFound 면 404 를 결과로 돌려준다", async () => {
    handler = (_req, res) => {
      res.writeHead(404);
      res.end();
    };
    const res = await makeClient().get(`${baseUrl}/`, { allowNotFound: true });
    expect(res.status).toBe(404);
    expect(res.body).toBe("");
  });

  it("403 은 재시도하지 않는다", async () => {
    let hits = 0;
    handler = (_req, res) => {
      hits++;
      res.writeHead(403);
      res.end();
    };
    await expect(makeClient({ maxRetries: 3 }).get(`${baseUrl}/`)).rejects.toMatchObject({ code: "http_error" });
    expect(hits).toBe(1);
  });

  it("503 은 재시도하고 성공하면 결과를 돌려준다", async () => {
    let hits = 0;
    handler = (_req, res) => {
      hits++;
      if (hits < 3) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("recovered");
    };
    const res = await makeClient({ maxRetries: 3 }).get(`${baseUrl}/`);
    expect(res.body).toBe("recovered");
    expect(hits).toBe(3);
  });

  it("재시도 횟수를 소진하면 마지막 에러를 올린다", async () => {
    let hits = 0;
    handler = (_req, res) => {
      hits++;
      res.writeHead(500);
      res.end();
    };
    await expect(makeClient({ maxRetries: 2 }).get(`${baseUrl}/`)).rejects.toThrowError(LeadOpsError);
    expect(hits).toBe(3); // 최초 1 + 재시도 2
  });

  it("정책 위반(SSRF)은 재시도하지 않는다", async () => {
    let hits = 0;
    handler = (_req, res) => {
      hits++;
      // 사설 대역은 테스트 정책에서도 차단되고, ssrf_blocked 는 retryable=false 다.
      res.writeHead(302, { location: "http://10.0.0.1/internal" });
      res.end();
    };
    await expect(makeClient({ maxRetries: 3 }).get(`${baseUrl}/`)).rejects.toMatchObject({
      code: "ssrf_blocked",
      retryable: false,
    });
    expect(hits).toBe(1);
  });
});

describe("HttpClient — 기본 정책은 loopback 도 막는다", () => {
  const strict = (): HttpClient =>
    new HttpClient({
      userAgent: "LeadOpsBot/1.0",
      perDomainIntervalMs: 0,
      globalConcurrency: 4,
      connectTimeoutMs: 2_000,
      totalTimeoutMs: 5_000,
      maxRetries: 0,
      maxBodyBytes: 1024,
      maxRedirects: 3,
    });

  it("ssrfPolicy 를 지정하지 않으면 로컬 서버 접근이 차단된다", async () => {
    // 임의 포트를 쓰므로 포트 검사에서 먼저 걸린다. 중요한 것은 차단된다는 사실이다.
    await expect(strict().get(`${baseUrl}/`)).rejects.toMatchObject({ code: "ssrf_blocked" });
  });

  it("포트가 허용 범위라도 loopback IP 자체를 차단한다", async () => {
    await expect(strict().get("http://127.0.0.1/")).rejects.toThrowError(/차단된 IP 대역: 127\.0\.0\.1/);
  });

  it("클라우드 메타데이터 주소를 차단한다", async () => {
    await expect(strict().get("http://169.254.169.254/latest/meta-data/")).rejects.toThrowError(
      /차단된 IP 대역: 169\.254\.169\.254/,
    );
  });
});

describe("loopbackPolicyForTests — 자기방어", () => {
  it("NODE_ENV 가 test 가 아니면 정책 생성 자체가 실패한다", () => {
    const original = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      expect(() => loopbackPolicyForTests()).toThrowError(/NODE_ENV=test 에서만/);
    } finally {
      process.env["NODE_ENV"] = original;
    }
  });

  it("test 환경에서는 loopback 만 허용하고 다른 사설 대역은 허용하지 않는다", () => {
    const p = loopbackPolicyForTests();
    expect(p.allowLoopback).toBe(true);
    expect(p.allowAnyPort).toBe(true);
  });
});
