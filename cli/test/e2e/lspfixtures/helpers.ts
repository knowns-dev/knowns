// Shared helpers for the LSP fixture smoke tests (port of tests/lspfixtures/lsp_fixture_test.go).
//
// The fixtures need real external language servers, so every suite is gated behind
// TEST_LSP_FIXTURES=1, as the Go tests were. Locally a missing server skips the suite; with CI=1 a
// missing server fails it (Go requireTool: Skipf locally, Fatalf in CI).
//
// Binary under test: KNOWNS_TS_BIN when set (a compiled binary), else `bun src/main.ts`, via
// tsSide() in ../../rollback/binaries.ts. Never Go.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSession } from "../../mcp/harness.ts";
import { tsSide } from "../../rollback/binaries.ts";
import { McpClient } from "../mcp-client.ts";

export const LSP_FIXTURES = process.env.TEST_LSP_FIXTURES === "1";

/** Go: TEST_LSP_FIXTURE narrows the direct-manager fixtures (json, yaml, terraform) to one. */
export function fixtureSelected(name: string): boolean {
  const selected = (process.env.TEST_LSP_FIXTURE ?? "").trim();
  return selected === "" || selected === name;
}

/**
 * Whether a suite should run: fixtures enabled, and (in CI) always, locally only when every
 * required tool is on PATH. In CI a missing tool then fails inside the test via requireTools.
 */
export function shouldRun(tools: string[], fixture?: string): boolean {
  if (!LSP_FIXTURES) return false;
  if (fixture !== undefined && !fixtureSelected(fixture)) return false;
  if (process.env.CI) return true;
  return tools.every(hasTool);
}

export function hasTool(name: string): boolean {
  return Bun.which(name, { PATH: process.env.PATH ?? "" }) !== null;
}

/** Fails (CI) when a tool is missing; shouldRun already skipped the suite locally. */
export function requireTools(...names: string[]): void {
  for (const n of names) {
    if (!hasTool(n)) throw new Error(`${n} not found in PATH`);
  }
}

// --- sandboxes -----------------------------------------------------------------------------------

const roots: string[] = [];

export function cleanupFixtures(): void {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

export interface Sandbox {
  /** Scratch root holding home and any cloned or generated project. */
  root: string;
  home: string;
  /** The env both the CLI and the MCP server run with (Go testEnv). */
  env: Record<string, string>;
}

/** An isolated HOME plus the env the Go tests used (short LSP daemon lease, dotnet caches). */
export function makeSandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "knowns-lspfx-")));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const env: Record<string, string> = {
    NO_COLOR: "1",
    NO_UPDATE_CHECK: "1",
    KNOWNS_RUNTIME_INLINE: "1",
    // `knowns init` would otherwise download language servers for 60s+; the tools under test come
    // from PATH (CI installs them before the job runs).
    KNOWN_LSP_AUTO_INSTALL: "0",
    // Unset means the daemon is on (the Go env did not touch it); the CI job exports 0.
    KNOWNS_LSP_DAEMON: process.env.KNOWNS_LSP_DAEMON ?? "1",
    KNOWNS_LSP_DAEMON_IDLE_TIMEOUT: "2s",
    KNOWNS_LSP_DAEMON_LEASE_TTL: "2s",
    HOME: home,
    USERPROFILE: home,
    DOTNET_CLI_HOME: home,
    DOTNET_NOLOGO: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    NUGET_PACKAGES: join(home, ".nuget", "packages"),
  };
  if (process.platform === "win32") {
    const m = /^([A-Za-z]:)(.*)$/.exec(home);
    if (m) {
      env.HOMEDRIVE = m[1] as string;
      env.HOMEPATH = m[2] as string;
    }
  }
  return { root, home, env };
}

/** A project directory inside the sandbox. */
export function makeProjectDir(sb: Sandbox, name = "project"): string {
  const dir = join(sb.root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Process env for a child: the parent's, with the sandbox on top. */
export function childEnv(sb: Sandbox): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;
  return { ...base, ...sb.env };
}

// --- running commands ----------------------------------------------------------------------------

export interface CmdResult {
  stdout: string;
  stderr: string;
  /** Set when the command failed or timed out. */
  err?: string;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

/** Go runCmd: runs a command with a timeout and returns its output, never throwing. */
export async function runCmd(
  dir: string | undefined,
  timeoutMs: number,
  env: Record<string, string> | undefined,
  cmd: string[],
): Promise<CmdResult> {
  const proc = Bun.spawn(cmd, {
    cwd: dir,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const out: CmdResult = { stdout, stderr };
  if (timedOut) out.err = `command timed out after ${timeoutMs}ms: ${cmd.join(" ")}`;
  else if (code !== 0) out.err = `exit status ${code}`;
  return out;
}

/** Fails the test with the command output when it did not succeed. */
export async function mustRun(
  dir: string | undefined,
  timeoutMs: number,
  env: Record<string, string> | undefined,
  cmd: string[],
): Promise<CmdResult> {
  const r = await runCmd(dir, timeoutMs, env, cmd);
  if (r.err) {
    throw new Error(
      `${cmd.join(" ")} failed: ${r.err}\nstdout: ${truncate(r.stdout, 2000)}\nstderr: ${truncate(r.stderr, 2000)}`,
    );
  }
  return r;
}

/** The knowns command under test. */
export function knownsCmd(): string[] {
  return tsSide().cmd;
}

/** `knowns init <name> --no-wizard --no-open --git-ignored` in a project directory. */
export async function initKnownsProject(
  sb: Sandbox,
  projectDir: string,
  name: string,
): Promise<void> {
  const r = await runCmd(projectDir, 60_000, childEnv(sb), [
    ...knownsCmd(),
    "init",
    name,
    "--no-wizard",
    "--no-open",
    "--git-ignored",
  ]);
  if (r.err) {
    throw new Error(`knowns init failed: ${r.err}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
}

/** Go decodeFirstJSON: the first JSON value in the output, trailing text ignored. */
export function decodeFirstJSON<T>(text: string): T {
  const data = text.trim();
  if (data === "") throw new Error("empty JSON input");
  try {
    return JSON.parse(data) as T;
  } catch {
    // Scan for the end of the first balanced value.
    const open = data[0];
    const close = open === "{" ? "}" : open === "[" ? "]" : "";
    if (close === "") throw new Error(`not JSON: ${truncate(data, 200)}`);
    let depth = 0;
    let inStr = false;
    for (let i = 0; i < data.length; i++) {
      const c = data[i];
      if (inStr) {
        if (c === "\\") i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) return JSON.parse(data.slice(0, i + 1)) as T;
    }
    throw new Error(`unterminated JSON: ${truncate(data, 200)}`);
  }
}

export async function runKnownsJSON<T>(
  sb: Sandbox,
  dir: string,
  timeoutMs: number,
  ...args: string[]
): Promise<T> {
  const r = await runCmd(dir, timeoutMs, childEnv(sb), [...knownsCmd(), ...args]);
  if (r.err) {
    throw new Error(
      `knowns ${args.join(" ")} failed: ${r.err}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
  }
  return decodeFirstJSON<T>(r.stdout);
}

// --- language status -----------------------------------------------------------------------------

/** One entry of `knowns lsp list --json`, the HTTP language API and MCP `project status`. */
export interface LanguageStatus {
  id: string;
  name?: string;
  status?: string;
  install_state?: string;
  installState?: string;
  running_state?: string;
  runningState?: string;
  backend?: string;
  backend_source?: string;
  backendSource?: string;
  log_path?: string;
  logPath?: string;
  capabilities_known?: boolean;
  capabilitiesKnown?: boolean;
  capabilities?: string[];
  advertised_capabilities?: string[];
  advertisedCapabilities?: string[];
  required_capabilities?: string[];
  requiredCapabilities?: string[];
  missing_capabilities?: string[];
  missingCapabilities?: string[];
}

export interface NormalizedStatus {
  id: string;
  status: string;
  installState: string;
  runningState: string;
  backend: string;
  logPath: string;
  capabilitiesKnown: boolean;
  capabilities: string[];
  advertised: string[];
  required: string[];
  missing: string[];
}

/** Go languageStatus.normalized: snake_case and camelCase spellings folded into one shape. */
export function normalizeStatus(s: LanguageStatus): NormalizedStatus {
  return {
    id: s.id,
    status: s.status ?? "",
    installState: s.install_state || s.installState || "",
    runningState: s.running_state || s.runningState || "",
    backend: s.backend ?? "",
    logPath: s.log_path || s.logPath || "",
    capabilitiesKnown: Boolean(s.capabilities_known || s.capabilitiesKnown),
    capabilities: s.capabilities ?? [],
    advertised: s.advertised_capabilities?.length
      ? s.advertised_capabilities
      : (s.advertisedCapabilities ?? []),
    required: s.required_capabilities?.length
      ? s.required_capabilities
      : (s.requiredCapabilities ?? []),
    missing: s.missing_capabilities?.length
      ? s.missing_capabilities
      : (s.missingCapabilities ?? []),
  };
}

export function requireLanguage(statuses: LanguageStatus[], id: string): NormalizedStatus {
  for (const s of statuses) {
    const n = normalizeStatus(s);
    if (n.id === id) return n;
  }
  throw new Error(`language "${id}" not found in statuses: ${JSON.stringify(statuses)}`);
}

export function containsAll(values: string[], required: string[]): boolean {
  return required.every((r) => values.includes(r));
}

export function sameStringSet(a: string[], b: string[]): boolean {
  return a.length === b.length && containsAll(a, b) && containsAll(b, a);
}

// --- MCP -----------------------------------------------------------------------------------------

export interface ToolPayload {
  raw: string;
  object: Record<string, unknown> | undefined;
  array: unknown[] | undefined;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** An initialised MCP server in the project, with a 120s request budget like the Go client. */
export class FixtureMcp {
  private constructor(private readonly client: McpClient) {}

  static async start(sb: Sandbox, projectDir: string): Promise<FixtureMcp> {
    const session = new McpSession("ts", {
      cwd: projectDir,
      home: sb.home,
      env: childEnv(sb),
    });
    const client = new McpClient(session);
    await client.initialize();
    const fx = new FixtureMcp(client);
    await fx.setProject(projectDir);
    return fx;
  }

  async setProject(projectDir: string): Promise<void> {
    const p = await this.callTool("project", { action: "set", projectRoot: projectDir });
    if (p.object?.success !== true) throw new Error(`project set failed: ${p.raw}`);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolPayload> {
    // 120s per request, as the Go client allowed (the first code call starts a language server).
    const raw = await this.client.session.request("tools/call", { name, arguments: args }, 120_000);
    if (raw.error) throw new Error(`mcp tool ${name} error: ${JSON.stringify(raw.error)}`);
    const content = (raw.result as { content?: Array<{ text?: string }> } | undefined)?.content;
    if (!content || content.length === 0) {
      throw new Error(`mcp tool ${name} returned no content: ${JSON.stringify(raw)}`);
    }
    const out = { text: content[0]?.text ?? "" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(out.text);
    } catch {
      parsed = undefined;
    }
    return {
      raw: out.text,
      object:
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : undefined,
      array: Array.isArray(parsed) ? parsed : undefined,
    };
  }

  /** Go callToolUntilRawContains: poll once a second until the raw text contains `want`. */
  async callToolUntilRawContains(
    timeoutMs: number,
    want: string,
    name: string,
    args: Record<string, unknown>,
    diagnostics: Array<() => string> = [],
  ): Promise<ToolPayload> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const payload = await this.callTool(name, args);
      if (payload.raw.includes(want)) return payload;
      if (Date.now() > deadline) {
        const details = diagnostics.map((d) => d().trim()).filter((d) => d !== "");
        throw new Error(
          `expected ${name} to contain "${want}", got: ${truncate(payload.raw, 1200)}${
            details.length > 0 ? `\n${details.join("\n")}` : ""
          }`,
        );
      }
      await sleep(1000);
    }
  }

  /** Go requireLiveCapabilityStatus: wait up to 20s for a healthy live capability baseline. */
  async requireLiveCapabilityStatus(
    languageId: string,
    ...required: string[]
  ): Promise<NormalizedStatus> {
    const deadline = Date.now() + 20_000;
    let last: NormalizedStatus | undefined;
    for (;;) {
      const payload = await this.callTool("project", { action: "status" });
      const snapshot = JSON.parse(payload.raw) as { lsp?: LanguageStatus[] };
      const found = (snapshot.lsp ?? []).find((s) => s.id === languageId);
      if (found) last = normalizeStatus(found);
      if (
        last &&
        last.runningState === "running" &&
        last.capabilitiesKnown &&
        last.status !== "degraded" &&
        last.missing.length === 0 &&
        containsAll(last.required, required) &&
        containsAll(last.capabilities, required)
      ) {
        if (last.backend === "") {
          throw new Error(
            `language "${languageId}" live capability status has no backend: ${JSON.stringify(last)}`,
          );
        }
        return last;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `language "${languageId}" did not report a healthy live capability baseline ${JSON.stringify(required)}: ${JSON.stringify(last)}`,
        );
      }
      await sleep(250);
    }
  }

  /** Go requireUnsupportedCodeAction: the action reports unsupported_capability, no fallback. */
  async requireUnsupportedCodeAction(
    status: NormalizedStatus,
    path: string,
    query: string,
    action: string,
    explanationContains: string,
    matchAdvertised: boolean,
  ): Promise<void> {
    const payload = await this.callTool("code", { action, path, query });
    const o = payload.object ?? {};
    if (o.error !== "unsupported_capability") {
      throw new Error(
        `${action} returned error ${JSON.stringify(o.error)}, want unsupported_capability without fallback: ${payload.raw}`,
      );
    }
    const wants: Record<string, string> = {
      language: status.id,
      backend: status.backend,
      action,
    };
    for (const [field, want] of Object.entries(wants)) {
      if (o[field] !== want) {
        throw new Error(
          `unsupported ${action} ${field} = ${JSON.stringify(o[field])}, want ${JSON.stringify(want)}: ${payload.raw}`,
        );
      }
    }
    const explanation = typeof o.explanation === "string" ? o.explanation : "";
    if (
      explanation.trim() === "" ||
      (explanationContains !== "" && !explanation.includes(explanationContains))
    ) {
      throw new Error(
        `unsupported ${action} explanation = ${JSON.stringify(explanation)}, want non-empty text containing "${explanationContains}": ${payload.raw}`,
      );
    }
    const advertised = o.advertised_capabilities;
    if (!Array.isArray(advertised) || !advertised.every((a) => typeof a === "string")) {
      throw new Error(
        `unsupported ${action} payload is missing advertised_capabilities: ${payload.raw}`,
      );
    }
    if (matchAdvertised && !sameStringSet(advertised as string[], status.advertised)) {
      throw new Error(
        `unsupported ${action} advertised capabilities = ${JSON.stringify(advertised)}, want live snapshot ${JSON.stringify(status.advertised)}: ${payload.raw}`,
      );
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

// --- HTTP browser server -------------------------------------------------------------------------

/** Go freePort: an unused loopback port. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface BrowserServer {
  stderr: () => string;
  stop: () => Promise<void>;
}

/** Go startBrowser: `knowns browser --no-open --port N --project DIR`. */
export function startBrowser(sb: Sandbox, projectDir: string, port: number): BrowserServer {
  const proc = Bun.spawn(
    [...knownsCmd(), "browser", "--no-open", "--port", String(port), "--project", projectDir],
    { cwd: projectDir, env: childEnv(sb), stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  let err = "";
  void (async () => {
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      err += new TextDecoder().decode(chunk);
    }
  })();
  return {
    stderr: () => err,
    stop: async () => {
      proc.kill("SIGINT");
      const t = setTimeout(() => proc.kill("SIGKILL"), 5000);
      await proc.exited;
      clearTimeout(t);
    },
  };
}

/** Go waitForJSON: GET until a 200 with a JSON body, or throw after the timeout. */
export async function waitForJSON<T>(url: string, timeoutMs: number): Promise<T> {
  const requestTimeout = Math.min(35_000, timeoutMs);
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(requestTimeout) });
      const body = await resp.text();
      if (resp.status === 200) {
        try {
          return JSON.parse(body) as T;
        } catch (e) {
          lastErr = String(e);
        }
      } else {
        lastErr = `status ${resp.status}: ${truncate(body, 300)}`;
      }
    } catch (e) {
      lastErr = String(e);
    }
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${url}: ${lastErr}`);
}

/** Go readFailureFile: a log's tail for a failure message. */
export function readFailureFile(label: string, path: string, max: number): string {
  if (path.trim() === "") return "";
  try {
    statSync(path);
    return `${label} (${path}):\n${truncate(readFileSync(path, "utf8"), max)}`;
  } catch (e) {
    return `${label} unavailable at ${path}: ${(e as Error).message}`;
  }
}
