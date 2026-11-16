// MCP client helpers for the e2e suite: a real `knowns mcp --stdio` process over JSON-RPC, a fresh
// git + `knowns init` project per test, and the same JSON unwrapping the Go e2e client did
// (tests/helpers_test.go: MCPClient, setupTestProject).
//
// Binary under test: KNOWNS_TS_BIN when set (a compiled binary; CI uses it), else `bun src/main.ts`
// (see tsSide() in ../rollback/binaries.ts and McpSession in ../mcp/harness.ts). Never Go.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSession } from "../mcp/harness.ts";
import { run, tsSide } from "../rollback/binaries.ts";

const roots: string[] = [];

/** Removes every sandbox this process created. Call from afterAll. */
export function cleanupE2e(): void {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

export interface E2eProject {
  /** The initialised project directory. */
  dir: string;
  /** The sandbox HOME, so the server never touches the real ~/.knowns. */
  home: string;
}

/** A temp HOME and a project directory (git init, git user, `knowns init e2e-test --no-wizard`). */
export function setupProject(): E2eProject {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "knowns-e2e-mcp-")));
  roots.push(root);
  const dir = join(root, "project");
  const home = join(root, "home");
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  git("init");
  git("config", "user.email", "test@e2e.local");
  git("config", "user.name", "E2E Test");
  const env = {
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: "1",
    NO_UPDATE_CHECK: "1",
    CI: "1",
    KNOWNS_RUNTIME_INLINE: "1",
    // init would otherwise try to install language servers; the MCP e2e flows do not need them.
    KNOWN_LSP_AUTO_INSTALL: "0",
    KNOWNS_LSP_DAEMON: "0",
  };
  const init = run(tsSide(), ["init", "e2e-test", "--no-wizard"], dir, env);
  if (init.code !== 0) {
    throw new Error(`knowns init failed (code ${init.code}): ${init.stderr}\n${init.stdout}`);
  }
  return { dir, home };
}

/** A tool result: the parsed JSON object (or `_array` for array responses) plus the raw text. */
export type ToolJson = Record<string, unknown> & { _array?: unknown[]; _raw?: string };

export class McpClient {
  constructor(readonly session: McpSession) {}

  /** Starts a server in `cwd` with `home` as HOME and performs the initialize handshake. */
  static async start(
    cwd: string,
    home: string,
    env: Record<string, string> = {},
  ): Promise<McpClient> {
    const session = new McpSession("ts", { cwd, home, env: { NO_COLOR: "1", ...env } });
    const client = new McpClient(session);
    await client.initialize();
    return client;
  }

  initialize() {
    return this.session.initialize();
  }

  /** The raw initialize response, for tests that read the server instructions. */
  initializeRaw() {
    return this.session.initialize();
  }

  /** Points the server at a project (the `project set` tool). */
  async setProject(dir: string): Promise<void> {
    const r = await this.call("project", { action: "set", projectRoot: dir });
    if (r.success !== true) throw new Error(`project set failed: ${JSON.stringify(r)}`);
  }

  /**
   * Calls a tool and parses its JSON result. tasks/docs create and update ask for the full entity
   * (`return: "full"`), as the Go e2e helper did, because those mutations answer with a summary by
   * default; tests of the compact response use callRaw.
   */
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolJson> {
    const action = args.action;
    const wantsFull =
      (name === "tasks" || name === "docs") &&
      (action === "create" || action === "update") &&
      !("return" in args);
    const out = await this.session.tool(name, wantsFull ? { ...args, return: "full" } : args);
    if (out.raw.error) {
      throw new Error(`MCP error calling ${name}: ${JSON.stringify(out.raw.error)}`);
    }
    const parsed = JSON.parse(out.text) as unknown;
    if (Array.isArray(parsed)) return { _array: parsed, _raw: out.text };
    return parsed as ToolJson;
  }

  /** Calls a tool and returns its raw text, including an error result's message. */
  async callRaw(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const out = await this.session.tool(name, args);
    if (out.raw.error) {
      throw new Error(`MCP error calling ${name}: ${JSON.stringify(out.raw.error)}`);
    }
    return out.text;
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}

/** A started server with `project set` already done, plus its project sandbox. */
export async function startWithProject(
  env: Record<string, string> = {},
): Promise<{ client: McpClient; project: E2eProject }> {
  const project = setupProject();
  const client = await McpClient.start(project.dir, project.home, env);
  await client.setProject(project.dir);
  return { client, project };
}
