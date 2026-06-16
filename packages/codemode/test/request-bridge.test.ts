import { describe, it, expect } from "vitest";
import { createRequestBridge } from "../src/request-bridge.js";
import type { RequestHandler } from "../src/types.js";

// Simple echo handler — returns the request details as JSON
const echoHandler: RequestHandler = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const headers: Record<string, string> = {};
  if (init?.headers) {
    for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
      headers[k] = v;
    }
  }
  return Response.json({
    url,
    method: init?.method,
    headers,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  });
};

describe("SSRF path validation", () => {
  const bridge = createRequestBridge(echoHandler, "http://localhost");

  it("rejects absolute URLs in path", async () => {
    await expect(
      bridge({ method: "GET", path: "https://evil.com/data" }),
    ).rejects.toThrow('must not contain "://"');
  });

  it("rejects protocol-relative paths", async () => {
    await expect(
      bridge({ method: "GET", path: "//evil.com/data" }),
    ).rejects.toThrow('must not start with "//"');
  });

  it("rejects paths not starting with /", async () => {
    await expect(
      bridge({ method: "GET", path: "evil.com/data" }),
    ).rejects.toThrow('must start with "/"');
  });

  it("allows valid relative paths", async () => {
    const res = await bridge({ method: "GET", path: "/v1/clusters" });
    expect(res.status).toBe(200);
    const body = res.body as { url: string };
    expect(body.url).toBe("http://localhost/v1/clusters");
  });

  it("rejects paths with null bytes", async () => {
    await expect(
      bridge({ method: "GET", path: "/api\x00/admin" }),
    ).rejects.toThrow("null bytes");
  });

  it("rejects paths with CR/LF (request smuggling)", async () => {
    await expect(
      bridge({ method: "GET", path: "/api\r\nX-Injected: true" }),
    ).rejects.toThrow("CR/LF");
  });

  it("rejects paths with backslashes", async () => {
    await expect(
      bridge({ method: "GET", path: "/api\\evil.com" }),
    ).rejects.toThrow("backslashes");
  });
});

describe("HTTP method validation", () => {
  const bridge = createRequestBridge(echoHandler, "http://localhost");

  it("allows standard HTTP methods", async () => {
    // Sequential: each call asserts independently
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const res = await bridge({ method, path: "/test" }); // oxlint-disable-line no-await-in-loop
      expect(res.status).toBe(200);
    }
  });

  it("allows lowercase methods (normalizes to uppercase)", async () => {
    const res = await bridge({ method: "get", path: "/test" });
    expect(res.status).toBe(200);
    expect((res.body as { method: string }).method).toBe("GET");
  });

  it("rejects non-standard methods", async () => {
    await expect(
      bridge({ method: "CONNECT", path: "/test" }),
    ).rejects.toThrow("Invalid HTTP method");

    await expect(
      bridge({ method: "TRACE", path: "/test" }),
    ).rejects.toThrow("Invalid HTTP method");
  });
});

describe("request limits", () => {
  it("enforces maxRequests", async () => {
    const bridge = createRequestBridge(echoHandler, "http://localhost", {
      maxRequests: 3,
    });

    await bridge({ method: "GET", path: "/1" });
    await bridge({ method: "GET", path: "/2" });
    await bridge({ method: "GET", path: "/3" });

    await expect(
      bridge({ method: "GET", path: "/4" }),
    ).rejects.toThrow("Request limit exceeded");
  });

  it("uses default limit of 50", async () => {
    const bridge = createRequestBridge(echoHandler, "http://localhost");

    // Sequential: must increment request counter one at a time
    for (let i = 0; i < 50; i++) {
      await bridge({ method: "GET", path: `/req-${i}` }); // oxlint-disable-line no-await-in-loop
    }

    // 51st should fail
    await expect(
      bridge({ method: "GET", path: "/req-51" }),
    ).rejects.toThrow("Request limit exceeded");
  });

  it("rejects request bodies exceeding maxRequestBytes", async () => {
    const bridge = createRequestBridge(echoHandler, "http://localhost", {
      maxRequestBytes: 64,
    });

    await expect(
      bridge({
        method: "POST",
        path: "/too-large",
        body: { payload: "x".repeat(128) },
      }),
    ).rejects.toThrow("Request body too large");
  });
});

describe("header filtering", () => {
  it("strips dangerous headers by default (blocklist mode)", async () => {
    const bridge = createRequestBridge(echoHandler, "http://localhost");

    const res = await bridge({
      method: "GET",
      path: "/test",
      headers: {
        "authorization": "Bearer secret",
        "cookie": "session=abc",
        "host": "evil.com",
        "origin": "https://evil.com",
        "referer": "https://evil.com/page",
        "x-forwarded-for": "1.2.3.4",
        "x-real-ip": "1.2.3.4",
        "x-client-ip": "1.2.3.4",
        "cf-connecting-ip": "1.2.3.4",
        "true-client-ip": "1.2.3.4",
        "proxy-authorization": "secret",
        "transfer-encoding": "chunked",
        "connection": "keep-alive",
        "upgrade": "websocket",
        "te": "trailers",
        "forwarded": "for=1.2.3.4;host=evil.com",
        "content-length": "999",
        "x-http-method-override": "DELETE",
        "x-original-url": "/admin",
        "x-rewrite-url": "/admin",
        "x-custom": "safe",
        "accept": "application/json",
      },
    });

    const body = res.body as { headers: Record<string, string> };
    expect(body.headers["authorization"]).toBeUndefined();
    expect(body.headers["cookie"]).toBeUndefined();
    expect(body.headers["host"]).toBeUndefined();
    expect(body.headers["origin"]).toBeUndefined();
    expect(body.headers["referer"]).toBeUndefined();
    expect(body.headers["x-forwarded-for"]).toBeUndefined();
    expect(body.headers["x-real-ip"]).toBeUndefined();
    expect(body.headers["x-client-ip"]).toBeUndefined();
    expect(body.headers["cf-connecting-ip"]).toBeUndefined();
    expect(body.headers["true-client-ip"]).toBeUndefined();
    expect(body.headers["proxy-authorization"]).toBeUndefined();
    expect(body.headers["transfer-encoding"]).toBeUndefined();
    expect(body.headers["connection"]).toBeUndefined();
    expect(body.headers["upgrade"]).toBeUndefined();
    expect(body.headers["te"]).toBeUndefined();
    expect(body.headers["forwarded"]).toBeUndefined();
    expect(body.headers["content-length"]).toBeUndefined();
    expect(body.headers["x-http-method-override"]).toBeUndefined();
    expect(body.headers["x-original-url"]).toBeUndefined();
    expect(body.headers["x-rewrite-url"]).toBeUndefined();
    expect(body.headers["x-custom"]).toBe("safe");
    expect(body.headers["accept"]).toBe("application/json");
  });

  it("uses allowedHeaders whitelist when provided", async () => {
    const bridge = createRequestBridge(echoHandler, "http://localhost", {
      allowedHeaders: ["accept", "content-type"],
    });

    const res = await bridge({
      method: "GET",
      path: "/test",
      headers: {
        "accept": "application/json",
        "content-type": "text/plain",
        "authorization": "Bearer secret",
        "x-custom": "value",
      },
    });

    const body = res.body as { headers: Record<string, string> };
    expect(body.headers["accept"]).toBe("application/json");
    expect(body.headers["content-type"]).toBe("text/plain");
    expect(body.headers["authorization"]).toBeUndefined();
    expect(body.headers["x-custom"]).toBeUndefined();
  });

  it("never forwards protected headers even when allowedHeaders includes them", async () => {
    const bridge = createRequestBridge(echoHandler, "http://localhost", {
      allowedHeaders: ["authorization", "cookie", "host", "forwarded", "accept"],
    });

    const res = await bridge({
      method: "GET",
      path: "/test",
      headers: {
        "authorization": "Bearer secret",
        "cookie": "session=abc",
        "host": "evil.com",
        "forwarded": "for=1.2.3.4;host=evil.com",
        "accept": "application/json",
      },
    });

    const body = res.body as { headers: Record<string, string> };
    expect(body.headers["authorization"]).toBeUndefined();
    expect(body.headers["cookie"]).toBeUndefined();
    expect(body.headers["host"]).toBeUndefined();
    expect(body.headers["forwarded"]).toBeUndefined();
    expect(body.headers["accept"]).toBe("application/json");
  });
});

describe("response header filtering", () => {
  it("does not expose response headers to sandbox code by default", async () => {
    const bridge = createRequestBridge(
      () =>
        Response.json(
          { ok: true },
          {
            headers: {
              "set-cookie": "session=secret",
              "x-internal-trace": "trace-secret",
            },
          },
        ),
      "http://localhost",
    );

    const res = await bridge({ method: "GET", path: "/test" });

    expect(res.headers).toEqual({});
  });

  it("exposes only explicitly allowed response headers", async () => {
    const bridge = createRequestBridge(
      () =>
        Response.json(
          { ok: true },
          {
            headers: {
              "etag": '"abc123"',
              "set-cookie": "session=secret",
            },
          },
        ),
      "http://localhost",
      { exposedResponseHeaders: ["etag"] },
    );

    const res = await bridge({ method: "GET", path: "/test" });

    expect(res.headers).toEqual({ etag: '"abc123"' });
  });
});

const largeHandler: RequestHandler = () => {
  const bigBody = "x".repeat(1024);
  return new Response(bigBody, {
    headers: { "content-type": "text/plain" },
  });
};

const smallHandler: RequestHandler = () => {
  return Response.json({ ok: true });
};

describe("response size limits", () => {
  it("rejects responses exceeding maxResponseBytes", async () => {
    const bridge = createRequestBridge(largeHandler, "http://localhost", {
      maxResponseBytes: 512,
    });

    await expect(
      bridge({ method: "GET", path: "/big" }),
    ).rejects.toThrow("Response too large");
  });

  it("allows responses within limit", async () => {
    const bridge = createRequestBridge(smallHandler, "http://localhost", {
      maxResponseBytes: 1024,
    });

    const res = await bridge({ method: "GET", path: "/small" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
