// The two middlewares in front of every route: trustedOriginMiddleware (server.go) and rs/cors
// configured as AllowOriginFunc=true, credentials, the Go method and header lists, MaxAge 300.
import { httpError } from "./http.ts";

const ALLOWED_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];
const ALLOWED_HEADERS = new Set([
  "accept",
  "authorization",
  "content-type",
  "x-csrf-token",
  "origin",
]);

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  if (h.toLowerCase() === "localhost") return true;
  if (/^127(\.\d{1,3}){3}$/.test(h)) return true;
  return h === "::1" || h.toLowerCase() === "0:0:0:0:0:0:0:1";
}

function requestHostOf(hostHeader: string): string {
  // net.SplitHostPort, else Trim "[]".
  const m = /^\[([^\]]*)\]:\d+$/.exec(hostHeader) ?? /^([^:]*):\d+$/.exec(hostHeader);
  return m ? (m[1] as string) : hostHeader.replace(/^\[|\]$/g, "");
}

/** Returns a 403 response for a cross-site or untrusted-host request. */
export function trustedOrigin(req: Request, allowPublicHost: () => boolean): Response | undefined {
  const requestHost = requestHostOf(req.headers.get("host") ?? new URL(req.url).host);
  if (!isLoopbackHost(requestHost) && !allowPublicHost()) {
    return httpError(403, "untrusted request host");
  }
  const origin = req.headers.get("origin") ?? "";
  if (origin === "") return undefined;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return httpError(403, "untrusted request origin");
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.hostname === "") {
    return httpError(403, "untrusted request origin");
  }
  const originHost = u.hostname.replace(/^\[|\]$/g, "");
  if (
    originHost.toLowerCase() !== requestHost.toLowerCase() &&
    !(isLoopbackHost(originHost) && isLoopbackHost(requestHost))
  ) {
    return httpError(403, "untrusted request origin");
  }
  return undefined;
}

const PREFLIGHT_VARY = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers";

/** An OPTIONS request carrying Access-Control-Request-Method is answered here, never routed. */
export function corsPreflight(req: Request): Response | undefined {
  if (req.method !== "OPTIONS" || !req.headers.has("access-control-request-method"))
    return undefined;
  const headers = new Headers({ Vary: PREFLIGHT_VARY });
  const origin = req.headers.get("origin") ?? "";
  const reqMethod = req.headers.get("access-control-request-method") ?? "";
  const reqHeaders = req.headers.get("access-control-request-headers") ?? "";
  const tokens = reqHeaders
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  if (
    origin !== "" &&
    ALLOWED_METHODS.includes(reqMethod.toUpperCase()) &&
    tokens.every((t) => ALLOWED_HEADERS.has(t))
  ) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", reqMethod);
    if (tokens.length > 0) headers.set("Access-Control-Allow-Headers", reqHeaders);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Max-Age", "300");
  }
  return new Response(null, { status: 204, headers });
}

/** Adds the actual-request headers rs/cors writes before calling the next handler. */
export function applyCors(req: Request, res: Response): void {
  res.headers.append("Vary", "Origin");
  const origin = req.headers.get("origin") ?? "";
  if (origin === "") return;
  if (!ALLOWED_METHODS.includes(req.method.toUpperCase())) return;
  res.headers.set("Access-Control-Allow-Origin", origin);
  res.headers.set("Access-Control-Allow-Credentials", "true");
  res.headers.set("Access-Control-Expose-Headers", "Link");
}
