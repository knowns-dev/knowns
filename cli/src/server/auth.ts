// internal/server/auth.go and routes/auth.go: in-memory password protection with session tokens.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { decodeStruct, GoJsonError } from "./gojson.ts";
import {
  type Ctx,
  clearSessionCookie,
  decodeBody,
  jsonResponse,
  type Router,
  respondError,
  setSessionCookie,
} from "./http.ts";
import type { Broadcaster } from "./sse.ts";

function token(): string {
  return randomBytes(32).toString("hex");
}

export class AuthManager {
  private sessions = new Map<string, number>();
  constructor(private password = "") {}

  setPassword(password: string): void {
    this.password = password;
    this.sessions = new Map();
  }
  removePassword(): void {
    this.password = "";
    this.sessions = new Map();
  }
  hasPassword(): boolean {
    return this.password !== "";
  }
  login(password: string): string | undefined {
    if (this.password === "") return undefined;
    const a = Buffer.from(password);
    const b = Buffer.from(this.password);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
    const t = token();
    this.sessions.set(t, Date.now());
    return t;
  }
  createSession(): string {
    const t = token();
    this.sessions.set(t, Date.now());
    return t;
  }
  validateSession(t: string): boolean {
    return this.sessions.has(t);
  }

  /** Middleware: returns a 401 response, or undefined to continue. */
  check(c: Ctx): Response | undefined {
    if (!this.hasPassword()) return undefined;
    const path = c.url.pathname;
    if (path === "/api/auth/login" || path === "/api/auth/status") return undefined;
    if (!path.startsWith("/api/") && !path.startsWith("/ws/")) return undefined;
    const cookie = c.cookie("knowns_session");
    if (cookie !== undefined && this.validateSession(cookie)) return undefined;
    const q = c.url.searchParams.get("token");
    if (q && this.validateSession(q)) return undefined;
    return jsonResponse(401, { error: "unauthorized", loginRequired: true });
  }
}

async function passwordBody(c: Ctx): Promise<string | Response> {
  const body = await decodeBody(c);
  if (!body.ok) return respondError(400, "invalid request body");
  try {
    const v = decodeStruct(body.value, "", { password: "string" });
    return (v.password as string | undefined) ?? "";
  } catch (e) {
    if (e instanceof GoJsonError) return respondError(400, "invalid request body");
    throw e;
  }
}

export function authRoutes(
  r: Router,
  auth: AuthManager,
  sse: Broadcaster,
  canRemovePassword: () => boolean,
): void {
  r.get("/api/auth/status", (c) => {
    let authenticated = false;
    if (auth.hasPassword()) {
      const cookie = c.cookie("knowns_session");
      if (cookie !== undefined) authenticated = auth.validateSession(cookie);
    }
    return jsonResponse(200, { authenticated, protected: auth.hasPassword() });
  });
  r.post("/api/auth/login", async (c) => {
    const pw = await passwordBody(c);
    if (typeof pw !== "string") return pw;
    if (pw === "") return respondError(400, "password is required");
    const t = auth.login(pw);
    if (t === undefined) return respondError(401, "invalid password");
    return jsonResponse(200, { success: true, token: t }, { "Set-Cookie": setSessionCookie(t) });
  });
  r.post("/api/auth/password", async (c) => {
    const pw = await passwordBody(c);
    if (typeof pw !== "string") return pw;
    if (pw === "") return respondError(400, "password cannot be empty");
    auth.setPassword(pw);
    const t = auth.createSession();
    sse.broadcast({ type: "auth:status", data: { protected: true } });
    return jsonResponse(
      200,
      { protected: true, success: true, token: t },
      { "Set-Cookie": setSessionCookie(t) },
    );
  });
  r.delete("/api/auth/password", (c) => {
    if (auth.hasPassword()) {
      const cookie = c.cookie("knowns_session");
      if (cookie === undefined || !auth.validateSession(cookie)) {
        return respondError(401, "unauthorized");
      }
    }
    if (!canRemovePassword()) {
      return respondError(409, "stop the public tunnel before removing password protection");
    }
    auth.removePassword();
    sse.broadcast({ type: "auth:status", data: { protected: false } });
    return jsonResponse(
      200,
      { protected: false, success: true },
      { "Set-Cookie": clearSessionCookie() },
    );
  });
}
