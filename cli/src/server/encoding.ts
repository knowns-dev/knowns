// Response encoding and validators for the web UI server: gzip/br for compressible bodies, a weak
// ETag with 304 on If-None-Match for JSON API reads, and the cache headers of the embedded UI.
// Server-sent events and ranged or already-encoded responses are never touched.
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

/** Bodies below this size are sent as they are: the header cost outweighs the saving. */
export const MIN_COMPRESS_BYTES = 1024;

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|wasm)|image\/svg\+xml)/i;

export type Encoding = "br" | "gzip";

/** The encoding to use for an Accept-Encoding header, or undefined for identity. */
export function pickEncoding(header: string | null, preferBrotli: boolean): Encoding | undefined {
  if (!header) return undefined;
  const q = new Map<string, number>();
  for (const part of header.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    let weight = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p);
      if (m) weight = Number(m[1]);
    }
    q.set(name.trim(), weight);
  }
  const ok = (e: string) => (q.get(e) ?? q.get("*") ?? 0) > 0;
  if (preferBrotli && ok("br")) return "br";
  if (ok("gzip")) return "gzip";
  if (ok("br")) return "br";
  return undefined;
}

export function isCompressible(contentType: string | null): boolean {
  return contentType !== null && COMPRESSIBLE.test(contentType);
}

export function encode(bytes: Uint8Array, enc: Encoding, quality?: number): Uint8Array {
  if (enc === "gzip") return gzipSync(bytes, { level: quality ?? 5 });
  return brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: quality ?? 5,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  });
}

/** A weak validator from the content (FNV-1a over the bytes, plus the length). */
export function weakEtag(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i] as number;
    h = Math.imul(h, 0x01000193);
  }
  return `W/"${(h >>> 0).toString(16)}-${bytes.length.toString(16)}"`;
}

/** If-None-Match against `etag`, with the weak comparison (RFC 9110 8.8.3.2). */
export function matches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  const bare = (s: string) => s.trim().replace(/^W\//, "");
  const want = bare(etag);
  return ifNoneMatch.split(",").some((t) => bare(t) === want);
}

function addVary(h: Headers): void {
  const v = h.get("Vary");
  if (!v) h.set("Vary", "Accept-Encoding");
  else if (!/accept-encoding/i.test(v)) h.set("Vary", `${v}, Accept-Encoding`);
}

/**
 * The API read path: an ETag and 304 for a GET that answered 200 JSON, then gzip (br when the
 * client takes only that) for a body of MIN_COMPRESS_BYTES or more.
 */
export async function finishApiResponse(req: Request, res: Response): Promise<Response> {
  if (req.method !== "GET" || res.status !== 200 || res.body === null) return res;
  const type = res.headers.get("Content-Type");
  if (!type || !/^application\/json/i.test(type)) return res;
  if (res.headers.has("Content-Encoding") || res.headers.has("Content-Range")) return res;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const headers = new Headers(res.headers);
  const etag = weakEtag(bytes);
  headers.set("ETag", etag);
  // Revalidate on every use; the 304 is what makes a repeat load cheap.
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-cache");
  addVary(headers);
  if (matches(req.headers.get("If-None-Match"), etag)) {
    headers.delete("Content-Type");
    headers.delete("Content-Length");
    return new Response(null, { status: 304, headers });
  }
  const enc =
    bytes.length >= MIN_COMPRESS_BYTES
      ? pickEncoding(req.headers.get("Accept-Encoding"), false)
      : undefined;
  if (!enc) return new Response(bytes, { status: 200, headers });
  const body = encode(bytes, enc);
  headers.set("Content-Encoding", enc);
  headers.delete("Content-Length");
  return new Response(body, { status: 200, headers });
}
