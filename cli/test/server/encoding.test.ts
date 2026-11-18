// KN-X5CAY2 (server): compression, validators and cache headers for the web UI server, and the
// metadata-only docs list. No oracle build is needed: the pieces are driven directly.
import { describe, expect, test } from "bun:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { finishApiResponse, matches, pickEncoding, weakEtag } from "../../src/server/encoding.ts";
import { toDocResponse, toDocSummary } from "../../src/server/routes/docs.ts";
import { serveUi } from "../../src/server/static.ts";
import { listUiAssets } from "../../src/ui.ts";

const big = JSON.stringify({
  docs: Array.from({ length: 200 }, (_, i) => ({ path: `d${i}`, body: "x".repeat(50) })),
});
const json = (body: string, extra: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "Content-Type": "application/json", ...extra } });
const get = (url: string, headers: Record<string, string> = {}) =>
  new Request(`http://x${url}`, { headers });

describe("Accept-Encoding", () => {
  test("picks gzip, br only when asked, and honours q=0", () => {
    expect(pickEncoding("gzip, deflate", false)).toBe("gzip");
    expect(pickEncoding("gzip, br", true)).toBe("br");
    expect(pickEncoding("gzip, br", false)).toBe("gzip");
    expect(pickEncoding("br", false)).toBe("br");
    expect(pickEncoding("gzip;q=0, br", false)).toBe("br");
    expect(pickEncoding("identity", true)).toBeUndefined();
    expect(pickEncoding(null, true)).toBeUndefined();
    expect(pickEncoding("*", false)).toBe("gzip");
  });
  test("weak comparison of If-None-Match", () => {
    const e = weakEtag(new TextEncoder().encode("abc"));
    expect(matches(e, e)).toBe(true);
    expect(matches(e.replace("W/", ""), e)).toBe(true);
    expect(matches(`"zzz", ${e}`, e)).toBe(true);
    expect(matches('"other"', e)).toBe(false);
    expect(matches("*", e)).toBe(true);
    expect(matches(null, e)).toBe(false);
  });
});

describe("JSON API responses", () => {
  test("a large GET is gzipped, carries an ETag and Vary, and round-trips", async () => {
    const res = await finishApiResponse(get("/api/docs", { "Accept-Encoding": "gzip" }), json(big));
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(res.headers.get("Vary")).toContain("Accept-Encoding");
    expect(res.headers.get("ETag")).toMatch(/^W\//);
    const raw = new Uint8Array(await res.arrayBuffer());
    expect(raw.length).toBeLessThan(big.length / 4);
    expect(new TextDecoder().decode(gunzipSync(raw))).toBe(big);
  });
  test("br is used when the client takes only br", async () => {
    const res = await finishApiResponse(get("/api/docs", { "Accept-Encoding": "br" }), json(big));
    expect(res.headers.get("Content-Encoding")).toBe("br");
    expect(
      new TextDecoder().decode(brotliDecompressSync(new Uint8Array(await res.arrayBuffer()))),
    ).toBe(big);
  });
  test("a tiny body and a client without Accept-Encoding stay identity", async () => {
    const tiny = await finishApiResponse(
      get("/api/x", { "Accept-Encoding": "gzip" }),
      json('{"a":1}'),
    );
    expect(tiny.headers.get("Content-Encoding")).toBeNull();
    expect(await tiny.text()).toBe('{"a":1}');
    const plain = await finishApiResponse(get("/api/docs"), json(big));
    expect(plain.headers.get("Content-Encoding")).toBeNull();
    expect(await plain.text()).toBe(big);
  });
  test("If-None-Match answers 304 with no body, on the identity and the gzip ETag alike", async () => {
    const first = await finishApiResponse(
      get("/api/docs", { "Accept-Encoding": "gzip" }),
      json(big),
    );
    const etag = first.headers.get("ETag") as string;
    for (const ae of ["gzip", ""]) {
      const res = await finishApiResponse(
        get("/api/docs", { "Accept-Encoding": ae, "If-None-Match": etag }),
        json(big),
      );
      expect(res.status).toBe(304);
      expect(await res.text()).toBe("");
      expect(res.headers.get("ETag")).toBe(etag);
    }
    const changed = await finishApiResponse(
      get("/api/docs", { "If-None-Match": etag }),
      json(big.replace("d0", "dZ")),
    );
    expect(changed.status).toBe(200);
  });
  test("SSE, errors, non-GET, non-JSON and encoded responses are left alone", async () => {
    const sse = new Response("data: x\n\n".repeat(500), {
      headers: { "Content-Type": "text/event-stream" },
    });
    expect(await finishApiResponse(get("/api/events", { "Accept-Encoding": "gzip" }), sse)).toBe(
      sse,
    );
    const err = new Response(big, { status: 500, headers: { "Content-Type": "application/json" } });
    expect(await finishApiResponse(get("/api/docs", { "Accept-Encoding": "gzip" }), err)).toBe(err);
    const post = json(big);
    const postReq = new Request("http://x/api/docs", {
      method: "POST",
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(await finishApiResponse(postReq, post)).toBe(post);
    const enc = json(big, { "Content-Encoding": "gzip" });
    expect(await finishApiResponse(get("/api/docs", { "Accept-Encoding": "gzip" }), enc)).toBe(enc);
  });
});

describe("embedded UI", () => {
  const files = listUiAssets();
  const hashed = files.find((f) => f.startsWith("assets/") && f.endsWith(".js"));
  const skip = !hashed || !files.includes("index.html");

  test.skipIf(skip)("a hashed asset is immutable, compressed once, and answers 304", async () => {
    const url = `/${hashed}`;
    const res = await serveUi(get(url, { "Accept-Encoding": "gzip, br" }), url);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("Vary")).toContain("Accept-Encoding");
    const enc = res.headers.get("Content-Encoding");
    const plain = await serveUi(get(url), url);
    expect(plain.headers.get("Content-Encoding")).toBeNull();
    const original = new Uint8Array(await plain.arrayBuffer());
    if (original.length >= 1024) {
      expect(enc).toBe("br");
      const back = brotliDecompressSync(new Uint8Array(await res.arrayBuffer()));
      expect(back.length).toBe(original.length);
    }
    const etag = plain.headers.get("ETag") as string;
    const again = await serveUi(get(url, { "If-None-Match": etag }), url);
    expect(again.status).toBe(304);
    const gz = await serveUi(get(url, { "Accept-Encoding": "gzip" }), url);
    if (original.length >= 1024) expect(gz.headers.get("Content-Encoding")).toBe("gzip");
  });

  test.skipIf(skip)("index.html and the SPA fallback are never cached hard", async () => {
    for (const url of ["/", "/docs/some/page"]) {
      const res = await serveUi(get(url), url);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
      expect(res.headers.get("Cache-Control")).toBe("no-cache");
    }
  });
});

describe("docs summary shape", () => {
  const doc = {
    id: "abc",
    canonicalHash: "h",
    path: "specs/a",
    folder: "specs",
    title: "A",
    description: "d",
    tags: ["t"],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    content: "héllo",
  };
  test("equals the full response without content, plus the UTF-8 size", () => {
    const full = toDocResponse(doc as never);
    const s = toDocSummary(doc as never);
    expect("content" in s).toBe(false);
    const { content: _c, ...rest } = full;
    expect(s).toEqual({ ...rest, size: 6 });
    expect((s.metadata as { canonicalHash: string }).canonicalHash).toBe("h");
  });
  test("an empty body has size 0 and still no content key", () => {
    const s = toDocSummary({ ...doc, content: "" } as never);
    expect(s.size).toBe(0);
    expect("content" in s).toBe(false);
  });
});
