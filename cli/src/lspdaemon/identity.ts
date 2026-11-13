// Ports of identity.go, handshake.go, paths.go and transport.go: project identity, daemon paths
// and the local endpoint naming. Every derived name is byte-identical to the Go daemon's so the
// two implementations find each other's sockets, state and tokens.
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { tokenEqual } from "./files.ts";

const maxKeyBaseLen = 48;
const isWindows = process.platform === "win32";

export const ErrProjectMismatch = new Error("lsp daemon project identity mismatch");
export const ErrTokenMismatch = new Error("lsp daemon token mismatch");

export interface ProjectIdentity {
  root: string;
  key: string;
}

export type TransportKind = "unix_socket" | "windows_pipe";
export const TransportUnixSocket: TransportKind = "unix_socket";
export const TransportWindowsPipe: TransportKind = "windows_pipe";

export interface TransportEndpoint {
  kind: TransportKind;
  address: string;
}

export interface Paths {
  project: ProjectIdentity;
  globalRoot: string;
  runtimeRoot: string;
  daemonDir: string;
  lockPath: string;
  statePath: string;
  tokenPath: string;
  logPath: string;
  socketPath: string;
  pipeName: string;
}

export interface Handshake {
  project_root: string;
  token: string;
}

/** CanonicalRoot: absolute path with best-effort symlink resolution. */
export function canonicalRoot(root: string): string {
  if (root.trim() === "") throw new Error("project root is required");
  let abs = resolve(root);
  try {
    abs = realpathSync.native(abs);
  } catch {
    // Missing paths keep their absolute cleaned form.
  }
  return resolve(abs);
}

function sanitizeKeyPart(value: string): string {
  const lower = value.toLowerCase();
  let out = "";
  let lastDash = false;
  for (const ch of lower) {
    const safe = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === ".";
    if (safe) {
      out += ch;
      lastDash = false;
      continue;
    }
    if (!lastDash) {
      out += "-";
      lastDash = true;
    }
  }
  return trimChars(out, "-._");
}

function trimChars(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a] as string)) a++;
  while (b > a && chars.includes(s[b - 1] as string)) b--;
  return s.slice(a, b);
}

export function keyForRoot(canonical: string): string {
  const clean = resolve(canonical);
  let base = sanitizeKeyPart(basename(clean));
  if (base === "") base = "project";
  if (base.length > maxKeyBaseLen) {
    base = trimChars(base.slice(0, maxKeyBaseLen), "-._");
    if (base === "") base = "project";
  }
  const hashInput = isWindows ? clean.toLowerCase() : clean;
  const sum = createHash("sha256").update(hashInput, "utf8").digest("hex");
  return `${base}-${sum.slice(0, 16)}`;
}

export function identifyProject(root: string): ProjectIdentity {
  const canonical = canonicalRoot(root);
  return { root: canonical, key: keyForRoot(canonical) };
}

export function sameRoot(a: string, b: string): boolean {
  const ca = resolve(a);
  const cb = resolve(b);
  return isWindows ? ca.toLowerCase() === cb.toLowerCase() : ca === cb;
}

/** ValidateHandshake: throws ErrProjectMismatch or ErrTokenMismatch. */
export function validateHandshake(
  expected: ProjectIdentity,
  expectedToken: string,
  request: Handshake,
): void {
  let requestRoot: string;
  try {
    requestRoot = canonicalRoot(request.project_root ?? "");
  } catch (e) {
    throw new HandshakeError(
      `${ErrProjectMismatch.message}: ${(e as Error).message}`,
      ErrProjectMismatch,
    );
  }
  if (!sameRoot(expected.root, requestRoot)) throw ErrProjectMismatch;
  const token = request.token ?? "";
  if (expectedToken === "" || token === "" || !tokenEqual(expectedToken, token)) {
    throw ErrTokenMismatch;
  }
}

class HandshakeError extends Error {
  override readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.cause = cause;
  }
}

// ---- paths ----

const daemonRuntimeDir = "lsp-daemon";

export function globalRoot(): string {
  let home = process.env.HOME || "";
  if (home === "") {
    try {
      home = homedir();
    } catch {
      home = "";
    }
  }
  if (home === "") return join(tmpdir(), ".knowns");
  return join(home, ".knowns");
}

export function runtimeRoot(): string {
  return join(globalRoot(), "runtime");
}

function shortKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
}

export function windowsPipeName(identity: ProjectIdentity): string {
  const key = identity.key === "" ? keyForRoot(identity.root) : identity.key;
  return `\\\\.\\pipe\\knowns-lsp-${key}`;
}

export function pathsForIdentity(identity: ProjectIdentity): Paths {
  const gRoot = globalRoot();
  const rRoot = join(gRoot, "runtime");
  const daemonDir = join(rRoot, daemonRuntimeDir, identity.key);
  return {
    project: identity,
    globalRoot: gRoot,
    runtimeRoot: rRoot,
    daemonDir,
    lockPath: join(daemonDir, "daemon.lock"),
    statePath: join(daemonDir, "state.json"),
    tokenPath: join(daemonDir, "token"),
    logPath: join(daemonDir, "daemon.log"),
    socketPath: join(tmpdir(), `knowns-lsp-${shortKey(identity.key)}.sock`),
    pipeName: windowsPipeName(identity),
  };
}

export function pathsForProject(root: string): Paths {
  return pathsForIdentity(identifyProject(root));
}

export function ensureDir(paths: Paths): void {
  mkdirSync(paths.daemonDir, { recursive: true, mode: 0o700 });
}

export function endpointForGOOS(paths: Paths, goos: string): TransportEndpoint {
  if (goos === "windows") return { kind: TransportWindowsPipe, address: paths.pipeName };
  return { kind: TransportUnixSocket, address: paths.socketPath };
}

export function endpoint(paths: Paths): TransportEndpoint {
  return endpointForGOOS(paths, isWindows ? "windows" : process.platform);
}
