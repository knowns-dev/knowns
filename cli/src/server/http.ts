// A small chi-shaped router over Bun's fetch handler: static beats {param} beats *, an unmatched
// method on a matched path is 405 with Allow, and the response helpers write what the Go handlers
// write (Content-Type: application/json and the Encoder's trailing newline).
import { decodeFirstValue, GoJsonError, goEncode } from "./gojson.ts";

export interface Ctx {
  req: Request;
  method: string;
  url: URL;
  /** chi.URLParam values, keyed by name ("*" for the wildcard). */
  params: Record<string, string>;
  /** Client address as seen by the socket (RealIP is not honoured for auth: nothing uses it). */
  remote: string;
  /** Reads the body once. */
  text(): Promise<string>;
  /** json.NewDecoder(body).Decode: throws GoJsonError with Go's text. */
  json(): Promise<unknown>;
  query(name: string): string;
  cookie(name: string): string | undefined;
}

export type Handler = (c: Ctx) => Response | Promise<Response>;

export function jsonResponse(
  status: number,
  data: unknown,
  headers?: ConstructorParameters<typeof Headers>[0],
): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  return new Response(data === undefined ? null : goEncode(data), { status, headers: h });
}

/** respondJSON with a nil body (Go: data == nil writes headers only). */
export function emptyJson(status: number): Response {
  return new Response(null, { status, headers: { "Content-Type": "application/json" } });
}

export function respondError(status: number, message: string): Response {
  return jsonResponse(status, { error: message });
}

/** http.Error: text/plain body plus newline, nosniff. */
export function httpError(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
  });
}

export const notFound = (): Response => httpError(404, "404 page not found");

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const METHOD_ORDER = [
  "CONNECT",
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "TRACE",
];

interface Route {
  method: string; // "*" matches every method
  segs: string[];
  handler: Handler;
}

function splitPath(p: string): string[] {
  return p.split("/").slice(1);
}

function matchSegs(pattern: string[], path: string[]): Record<string, string> | undefined {
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i] as string;
    if (p === "*") {
      params["*"] = path.slice(i).join("/");
      return params;
    }
    const seg = path[i];
    if (seg === undefined) return undefined;
    if (p.startsWith("{")) {
      if (seg === "") return undefined;
      params[p.slice(1, -1)] = seg;
    } else if (p !== seg) return undefined;
  }
  return path.length === pattern.length ? params : undefined;
}

function rank(seg: string | undefined): number {
  if (seg === undefined) return 4;
  if (seg === "*") return 1;
  return seg.startsWith("{") ? 2 : 3;
}

function moreSpecific(a: string[], b: string[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = rank(b[i]) - rank(a[i]);
    if (d !== 0) return d;
  }
  return 0;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, segs: splitPath(pattern), handler });
  }
  get(p: string, h: Handler): void {
    this.add("GET", p, h);
  }
  post(p: string, h: Handler): void {
    this.add("POST", p, h);
  }
  put(p: string, h: Handler): void {
    this.add("PUT", p, h);
  }
  patch(p: string, h: Handler): void {
    this.add("PATCH", p, h);
  }
  delete(p: string, h: Handler): void {
    this.add("DELETE", p, h);
  }
  all(p: string, h: Handler): void {
    this.add("*", p, h);
  }
  /** A mounted subrouter's catch-all (see resolve). */
  fallback(p: string, h: Handler): void {
    this.add(FALLBACK, p, h);
  }

  /** Resolves a request; the caller supplies the (chi-style) matching path. */
  resolve(
    method: string,
    path: string,
  ): { handler: Handler; params: Record<string, string> } | { status: 404 | 405; allow: string[] } {
    const segs = splitPath(path);
    const hits: { route: Route; params: Record<string, string> }[] = [];
    for (const route of this.routes) {
      const params = matchSegs(route.segs, segs);
      if (params) hits.push({ route, params });
    }
    hits.sort((x, y) => moreSpecific(x.route.segs, y.route.segs));
    // A mounted subrouter ("/api/*" for every method) only answers what its own routes do not
    // match: a more specific route with the wrong method is a 405, never the mount's 404.
    const fb = hits.find((h) => h.route.method === FALLBACK);
    const normal = hits.filter((h) => h.route.method !== FALLBACK);
    const specific = fb
      ? normal.filter((h) => moreSpecific(h.route.segs, (fb as { route: Route }).route.segs) < 0)
      : normal;
    const rest = fb ? normal.filter((h) => !specific.includes(h)) : [];
    const pick = (list: typeof hits) =>
      list.find((h) => h.route.method === "*" || h.route.method === method);
    const first = pick(specific);
    if (first) return { handler: first.route.handler, params: first.params };
    if (specific.length > 0) return { status: 405, allow: allowOf(specific) };
    if (fb) return { handler: fb.route.handler, params: fb.params };
    void rest;
    const any = pick(normal);
    if (any) return { handler: any.route.handler, params: any.params };
    if (normal.length === 0) return { status: 404, allow: [] };
    return { status: 405, allow: allowOf(normal) };
  }
}

const FALLBACK = "FALLBACK";

function allowOf(hits: { route: Route }[]): string[] {
  const allow = new Set<string>();
  for (const h of hits) if (h.route.method !== "*") allow.add(h.route.method);
  return METHOD_ORDER.filter((m) => allow.has(m));
}

const UNRESERVED = /[A-Za-z0-9\-_.~$&+,/:;=@]/;

/** url.URL.EscapedPath's canonical encoding of a decoded path. */
function canonicalEncode(decoded: string): string {
  let out = "";
  for (const ch of decoded) {
    if (UNRESERVED.test(ch)) out += ch;
    else
      for (const b of new TextEncoder().encode(ch))
        out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** The path chi routes on: RawPath when Go would have kept one, else the decoded Path. */
export function routingPath(rawPath: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
  return canonicalEncode(decoded) === rawPath ? decoded : rawPath;
}

export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"'))
      value = value.slice(1, -1);
    if (name !== "" && !out.has(name)) out.set(name, value);
  }
  return out;
}

export function makeCtx(req: Request, remote: string, params: Record<string, string>): Ctx {
  const url = new URL(req.url);
  let bodyText: Promise<string> | undefined;
  let cookies: Map<string, string> | undefined;
  return {
    req,
    method: req.method,
    url,
    params,
    remote,
    text: () => {
      bodyText ??= req.text();
      return bodyText;
    },
    async json() {
      bodyText ??= req.text();
      return decodeFirstValue(await bodyText);
    },
    query: (name) => url.searchParams.get(name) ?? "",
    cookie: (name) => {
      cookies ??= parseCookies(req.headers.get("cookie"));
      return cookies.get(name);
    },
  };
}

/** Reads a JSON body and maps a Go decode failure to the caller's 400. */
export async function decodeBody(
  c: Ctx,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await c.json() };
  } catch (e) {
    if (e instanceof GoJsonError) return { ok: false, error: e.message };
    throw e;
  }
}

export function setSessionCookie(token: string): string {
  return `knowns_session=${token}; Path=/; HttpOnly; SameSite=Lax`;
}
export function clearSessionCookie(): string {
  return "knowns_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax";
}
