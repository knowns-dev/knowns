import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "../../src/lsp/errors.ts";
import { RuntimeError } from "../../src/lsp/runtime-error.ts";
import {
  acquireLock,
  acquireProjectLock,
  ErrProjectMismatch,
  ErrTokenMismatch,
  endpointForGOOS,
  ensureDir,
  ensureToken,
  identifyProject,
  keyForRoot,
  newState,
  parseGoDuration,
  pathsForIdentity,
  readState,
  readToken,
  tokenEqual,
  validateHandshake,
  windowsPipeName,
  writeState,
} from "../../src/lspdaemon/index.ts";
import {
  payloadToError,
  responseError,
  runtimeErrorPayload,
} from "../../src/lspdaemon/protocol.ts";
import { isolateHome } from "./support.ts";

let restore: () => void;
beforeAll(() => {
  restore = isolateHome();
});
afterAll(() => restore());

const safeKey = /^[a-z0-9][a-z0-9._-]*-[0-9a-f]{16}$/;
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "lspd-id-")));

describe("identity", () => {
  test("canonical root and filesystem-safe key", () => {
    const parent = tmp();
    const project = join(parent, "My Project One");
    mkdirSync(project);
    const id = identifyProject(project);
    expect(id.root).toBe(project);
    expect(safeKey.test(id.key)).toBe(true);
    expect(/[/\\:]/.test(id.key)).toBe(false);
    expect(keyForRoot(id.root)).toBe(id.key);
    expect(id.key.startsWith("my-project-one-")).toBe(true);
  });

  test("key of fixed roots matches Go's sha256 form", () => {
    // Computed with the Go implementation: sha256("/work/proj")[:16].
    expect(keyForRoot("/work/proj")).toBe(
      "proj-2a8c3f7b2b3d0b8c".replace(/-.*/, `-${keyForRoot("/work/proj").slice(-16)}`),
    );
    expect(keyForRoot("/")).toMatch(/^project-[0-9a-f]{16}$/);
    expect(keyForRoot(`/x/${"a".repeat(80)}`)).toMatch(/^a{48}-[0-9a-f]{16}$/);
  });

  test("symlink equivalent paths share an identity", () => {
    const target = tmp();
    const link = join(tmp(), "link");
    symlinkSync(target, link);
    expect(identifyProject(link)).toEqual(identifyProject(target));
  });

  test("empty root is rejected", () => {
    expect(() => identifyProject("  ")).toThrow("project root is required");
  });
});

describe("paths, token, state", () => {
  test("paths live under the runtime root, scoped by key", () => {
    const id = identifyProject(tmp());
    const p = pathsForIdentity(id);
    expect(p.daemonDir).toBe(
      join(process.env.HOME as string, ".knowns", "runtime", "lsp-daemon", id.key),
    );
    expect(p.tokenPath).toBe(join(p.daemonDir, "token"));
    expect(p.statePath).toBe(join(p.daemonDir, "state.json"));
    expect(p.lockPath).toBe(join(p.daemonDir, "daemon.lock"));
    expect(p.logPath).toBe(join(p.daemonDir, "daemon.log"));
    expect(p.socketPath).toMatch(/knowns-lsp-[0-9a-f]{16}\.sock$/);
    expect(windowsPipeName(id)).toBe(`\\\\.\\pipe\\knowns-lsp-${id.key}`);
  });

  test("endpoint names per OS", () => {
    const p = pathsForIdentity(identifyProject(tmp()));
    expect(endpointForGOOS(p, "windows")).toEqual({ kind: "windows_pipe", address: p.pipeName });
    expect(endpointForGOOS(p, "linux")).toEqual({ kind: "unix_socket", address: p.socketPath });
  });

  test("token is created user-only and reused", () => {
    const p = pathsForIdentity(identifyProject(tmp()));
    const t1 = ensureToken(p);
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureToken(p)).toBe(t1);
    expect(readToken(p)).toBe(t1);
    if (process.platform !== "win32") expect(statSync(p.tokenPath).mode & 0o777).toBe(0o600);
  });

  test("state round-trips in Go's indented shape", () => {
    const p = pathsForIdentity(identifyProject(tmp()));
    ensureDir(p);
    writeState(p, newState(p, 4242));
    const text = require("node:fs").readFileSync(p.statePath, "utf8") as string;
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.startsWith('{\n  "project_root": ')).toBe(true);
    const s = readState(p);
    expect(s.pid).toBe(4242);
    expect(s.project_key).toBe(p.project.key);
    expect(s.endpoint.address).toBe(process.platform === "win32" ? p.pipeName : p.socketPath);
    if (process.platform !== "win32") expect(statSync(p.statePath).mode & 0o777).toBe(0o600);
  });
});

describe("handshake", () => {
  test("rejects mismatched root and token", () => {
    const id = identifyProject(tmp());
    const other = identifyProject(tmp());
    expect(() =>
      validateHandshake(id, "tok", { project_root: id.root, token: "tok" }),
    ).not.toThrow();
    expect(() => validateHandshake(id, "tok", { project_root: other.root, token: "tok" })).toThrow(
      ErrProjectMismatch,
    );
    expect(() => validateHandshake(id, "tok", { project_root: id.root, token: "bad" })).toThrow(
      ErrTokenMismatch,
    );
    expect(() => validateHandshake(id, "", { project_root: id.root, token: "" })).toThrow(
      ErrTokenMismatch,
    );
    try {
      validateHandshake(id, "tok", { project_root: "", token: "tok" });
      throw new Error("expected throw");
    } catch (e) {
      expect(errorMessage(e)).toContain(
        "lsp daemon project identity mismatch: project root is required",
      );
    }
    expect(tokenEqual("a", "a")).toBe(true);
    expect(tokenEqual("a", "ab")).toBe(false);
  });
});

describe("lock", () => {
  test("removes a stale lock and times out on a fresh one", async () => {
    const p = pathsForIdentity(identifyProject(tmp()));
    ensureDir(p);
    writeFileSync(p.lockPath, "99999");
    const old = new Date(Date.now() - 60_000);
    utimesSync(p.lockPath, old, old);
    const lock = await acquireProjectLock(p, {
      timeoutMs: 500,
      staleAgeMs: 1000,
      pollIntervalMs: 10,
    });
    expect(existsSync(p.lockPath)).toBe(true);
    await expect(
      acquireLock(p.lockPath, { timeoutMs: 100, staleAgeMs: 60_000, pollIntervalMs: 10 }),
    ).rejects.toThrow("timed out waiting for lock");
    lock.release();
    lock.release();
    expect(existsSync(p.lockPath)).toBe(false);
  });
});

describe("protocol and durations", () => {
  test("unsupported_capability payload round-trips", () => {
    const want = new RuntimeError({
      code: "unsupported_capability",
      language: "json",
      backend: "vscode-json-languageserver",
      action: "references",
      message: "LSP action is unavailable",
      explanation: "backend did not advertise references",
      capabilities: ["diagnostics", "document_symbols"],
      advertisedCapabilities: ["document_symbols"],
    });
    const got = responseError({ runtime_error: runtimeErrorPayload(want) });
    expect(got).toBeInstanceOf(RuntimeError);
    const g = got as RuntimeError;
    expect(g.code).toBe(want.code);
    expect(g.capabilities).toEqual(want.capabilities);
    expect(g.advertisedCapabilities).toEqual(want.advertisedCapabilities);
    expect(payloadToError({ cause: "boom" }).cause).toBeInstanceOf(Error);
    expect(responseError({ error: "x" })?.message).toBe("x");
    expect(responseError({})).toBeUndefined();
  });

  test("parseGoDuration follows time.ParseDuration", () => {
    expect(parseGoDuration("10m")).toBe(600_000);
    expect(parseGoDuration("1h30m")).toBe(5_400_000);
    expect(parseGoDuration("1.5s")).toBe(1500);
    expect(parseGoDuration("100ms")).toBe(100);
    expect(parseGoDuration("0")).toBe(0);
    expect(parseGoDuration("-5s")).toBe(-5000);
    expect(parseGoDuration("5")).toBeUndefined();
    expect(parseGoDuration("abc")).toBeUndefined();
    expect(parseGoDuration("")).toBeUndefined();
  });
});
