import { describe, expect, test } from "bun:test";
import { corsPreflight, trustedOrigin } from "../../src/server/cors.ts";
import {
  decodeFirstValue,
  decodeStruct,
  goEncode,
  scanFirstValue,
} from "../../src/server/gojson.ts";
import { Router, routingPath } from "../../src/server/http.ts";

describe("go json decoding", () => {
  test("syntax errors use Go's text", () => {
    expect(() => scanFirstValue("")).toThrow("EOF");
    expect(() => scanFirstValue("{")).toThrow("unexpected EOF");
    expect(() => scanFirstValue("{nope")).toThrow(
      "invalid character 'n' looking for beginning of object key string",
    );
    expect(() => scanFirstValue('{"a" 1}')).toThrow("invalid character '1' after object key");
    expect(() => scanFirstValue("[1 2]")).toThrow("invalid character '2' after array element");
    expect(() => scanFirstValue("tru!")).toThrow(
      "invalid character '!' in literal true (expecting 'e')",
    );
  });
  test("only the first value is read", () => {
    expect(decodeFirstValue('{"a":1} trailing')).toEqual({ a: 1 });
  });
  test("type errors name the struct field", () => {
    expect(() => decodeStruct({ taskId: 5 }, "startRequest", { taskId: "string" })).toThrow(
      "json: cannot unmarshal number into Go struct field startRequest.taskId of type string",
    );
    expect(decodeStruct({ TASKID: "x", extra: 1 }, "s", { taskId: "string" })).toEqual({
      taskId: "x",
    });
  });
  test("encoder escapes html and ends with a newline", () => {
    expect(goEncode({ a: "<&>" })).toBe('{"a":"\\u003c\\u0026\\u003e"}\n');
  });
});

describe("router", () => {
  const h = () => new Response("x");
  test("exact beats wildcard; wrong method is 405; the mount fallback is 404", () => {
    const r = new Router();
    r.get("/api/docs", h);
    r.get("/api/docs/*", h);
    r.post("/api/docs/*", h);
    r.fallback("/api/*", h);
    r.get("/*", h);
    expect("handler" in r.resolve("GET", "/api/docs")).toBe(true);
    expect(r.resolve("POST", "/api/docs")).toMatchObject({ handler: expect.any(Function) });
    expect(r.resolve("DELETE", "/api/docs")).toEqual({ status: 405, allow: ["GET", "POST"] });
    expect("handler" in r.resolve("DELETE", "/api/other")).toBe(true);
    expect(r.resolve("POST", "/kanban")).toEqual({ status: 405, allow: ["GET"] });
  });
  test("path params and raw paths", () => {
    const r = new Router();
    r.get("/api/tasks/{id}", h);
    const hit = r.resolve("GET", "/api/tasks/abc");
    expect("params" in hit && hit.params.id).toBe("abc");
    expect("status" in r.resolve("GET", "/api/tasks/")).toBe(true);
    expect(routingPath("/a%20b")).toBe("/a b");
    expect(routingPath("/a%2Fb")).toBe("/a%2Fb");
  });
});

describe("cors", () => {
  test("preflight grants only lowercase allowed headers", () => {
    const mk = (hdrs: string) =>
      corsPreflight(
        new Request("http://localhost/api/tasks", {
          method: "OPTIONS",
          headers: {
            Origin: "http://localhost:3000",
            "Access-Control-Request-Method": "PUT",
            "Access-Control-Request-Headers": hdrs,
          },
        }),
      ) as Response;
    expect(mk("content-type").headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );
    expect(mk("Content-Type").headers.get("access-control-allow-origin")).toBeNull();
  });
  test("untrusted hosts and origins are refused", () => {
    const req = (host: string, origin?: string) =>
      new Request("http://x/api", { headers: { host, ...(origin && { origin }) } });
    expect(trustedOrigin(req("example.com"), () => false)?.status).toBe(403);
    expect(trustedOrigin(req("example.com"), () => true)).toBeUndefined();
    expect(trustedOrigin(req("localhost:1", "http://evil.test"), () => false)?.status).toBe(403);
    // Approved divergence (D12, TSR-X86JV4): the origin must name the server's own port.
    expect(trustedOrigin(req("localhost:1", "http://127.0.0.1:9"), () => false)?.status).toBe(403);
    expect(trustedOrigin(req("localhost:3001", "http://localhost:5173"), () => false)?.status).toBe(
      403,
    );
    expect(trustedOrigin(req("localhost:3001", "http://localhost"), () => false)?.status).toBe(403);
    // Same server under another loopback name, same port: still trusted.
    expect(
      trustedOrigin(req("localhost:3001", "http://127.0.0.1:3001"), () => false),
    ).toBeUndefined();
    expect(trustedOrigin(req("[::1]:3001", "http://localhost:3001"), () => false)).toBeUndefined();
    expect(trustedOrigin(req("localhost:80", "http://localhost"), () => false)).toBeUndefined();
    // The tunnel: a public Host without a port, the browser's https origin (password set).
    const tunnel = "abc-def.trycloudflare.com";
    expect(trustedOrigin(req(tunnel, `https://${tunnel}`), () => true)).toBeUndefined();
    expect(trustedOrigin(req(tunnel, `https://${tunnel}:8443`), () => true)?.status).toBe(403);
    expect(trustedOrigin(req(tunnel, "https://other.trycloudflare.com"), () => true)?.status).toBe(
      403,
    );
    // KNOWNS_ALLOWED_ORIGINS: exact extra origins (the Vite dev UI on its own port), no wildcards.
    const dev = ["http://localhost:6421"];
    expect(
      trustedOrigin(req("localhost:6420", "http://localhost:6421"), () => false, dev),
    ).toBeUndefined();
    expect(
      trustedOrigin(req("localhost:6420", "http://localhost:6422"), () => false, dev)?.status,
    ).toBe(403);
    expect(
      trustedOrigin(req("localhost:6420", "http://evil.test:6421"), () => false, dev)?.status,
    ).toBe(403);
    expect(trustedOrigin(req("localhost:6420", "http://localhost:6421"), () => false)?.status).toBe(
      403,
    );
  });
});
