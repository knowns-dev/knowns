// A line-oriented MCP stdio client that drives either the Go binary (the oracle) or the TypeScript
// CLI (`bun src/main.ts mcp --stdio`, or a compiled binary via KNOWNS_TS_BIN) with the same JSON-RPC
// session, plus the masking Go's own nondeterminism needs.
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const GO_BIN = process.env.KNOWNS_GO_BIN;
export const hasGoBin = GO_BIN !== undefined && existsSync(GO_BIN);
export const TS_BIN = process.env.KNOWNS_TS_BIN;
const CLI_ROOT = join(import.meta.dir, "..", "..");
export const FIXTURES = join(CLI_ROOT, "test", "fixtures");

export type Side = "go" | "ts";

export interface Rpc {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface ToolOut {
  text: string;
  isError: boolean;
  raw: Rpc;
}

export interface SessionOptions {
  /** Project directory the server runs in (cwd). */
  cwd: string;
  /** HOME / USERPROFILE for the server. */
  home: string;
  env?: Record<string, string>;
  /** Extra CLI arguments after `mcp --stdio`. */
  args?: string[];
}

function command(side: Side): string[] {
  if (side === "go") {
    if (!GO_BIN) throw new Error("KNOWNS_GO_BIN is not set");
    return [GO_BIN];
  }
  return TS_BIN ? [TS_BIN] : [process.execPath, join(CLI_ROOT, "src", "main.ts")];
}

export class McpSession {
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private buf = "";
  private readonly waiters = new Map<number | string, (r: Rpc) => void>();
  private readonly early = new Map<number | string, Rpc>();
  private nextId = 1;
  readonly lines: string[] = [];
  stderr = "";
  private done: Promise<void>;

  constructor(
    readonly side: Side,
    opts: SessionOptions,
  ) {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: opts.home,
      USERPROFILE: opts.home,
      NO_UPDATE_CHECK: "1",
      CI: "1",
      KNOWNS_RUNTIME_INLINE: "1",
      KNOWN_LSP_AUTO_INSTALL: "0",
      KNOWNS_LSP_DAEMON: "0",
      ...opts.env,
    };
    this.proc = Bun.spawn([...command(side), "mcp", "--stdio", ...(opts.args ?? [])], {
      cwd: opts.cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.done = Promise.all([
      this.pump(this.proc.stdout as ReadableStream<Uint8Array>, (t) => this.onStdout(t)),
      this.pump(this.proc.stderr as ReadableStream<Uint8Array>, (t) => {
        this.stderr += t;
      }),
    ]).then(() => undefined);
  }

  private async pump(stream: ReadableStream<Uint8Array>, on: (t: string) => void): Promise<void> {
    const dec = new TextDecoder();
    for await (const chunk of stream) on(dec.decode(chunk, { stream: true }));
  }

  private onStdout(text: string): void {
    this.buf += text;
    for (let nl = this.buf.indexOf("\n"); nl >= 0; nl = this.buf.indexOf("\n")) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.lines.push(line);
      let msg: Rpc;
      try {
        msg = JSON.parse(line) as Rpc;
      } catch {
        continue;
      }
      const id = msg.id;
      if (id === undefined || id === null) continue;
      const w = this.waiters.get(id);
      if (w) {
        this.waiters.delete(id);
        w(msg);
      } else this.early.set(id, msg);
    }
  }

  /** Sends a raw line (a trailing newline is added). */
  sendRaw(line: string): void {
    (this.proc.stdin as unknown as { write(s: string): void; flush(): void }).write(`${line}\n`);
    (this.proc.stdin as unknown as { flush(): void }).flush();
  }

  /** Sends a request and waits for the response with its id. */
  request(method: string, params?: unknown, timeoutMs = 60_000): Promise<Rpc> {
    const id = this.nextId++;
    const msg: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) msg.params = params;
    return this.requestWithId(id, JSON.stringify(msg), timeoutMs);
  }

  requestWithId(id: number | string, line: string, timeoutMs = 60_000): Promise<Rpc> {
    const early = this.early.get(id);
    const p = new Promise<Rpc>((resolve, reject) => {
      if (early) {
        this.early.delete(id);
        resolve(early);
        return;
      }
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(
          new Error(
            `${this.side}: no response for ${id} within ${timeoutMs}ms; stderr=${this.stderr}`,
          ),
        );
      }, timeoutMs);
      this.waiters.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
    });
    this.sendRaw(line);
    return p;
  }

  notify(method: string, params?: unknown): void {
    const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    this.sendRaw(JSON.stringify(msg));
  }

  async initialize(): Promise<Rpc> {
    const r = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-test", version: "1" },
    });
    this.notify("notifications/initialized");
    return r;
  }

  /** tools/call, with the result unwrapped. */
  async tool(name: string, args: Record<string, unknown> = {}): Promise<ToolOut> {
    const raw = await this.request("tools/call", { name, arguments: args });
    const result = raw.result as
      | { content?: Array<{ text: string }>; isError?: boolean }
      | undefined;
    return {
      text: result?.content?.[0]?.text ?? JSON.stringify(raw.error ?? raw),
      isError: result?.isError === true,
      raw,
    };
  }

  /** Closes stdin and waits for the process to exit. */
  async close(): Promise<number> {
    try {
      (this.proc.stdin as unknown as { end(): void }).end();
    } catch {
      // already closed
    }
    const timer = setTimeout(() => this.proc.kill(), 20_000);
    const code = await this.proc.exited;
    clearTimeout(timer);
    await this.done;
    return code;
  }

  kill(): void {
    this.proc.kill();
  }
}

// --- project fixtures ----------------------------------------------------------------------------

export interface Sandbox {
  dir: string;
  home: string;
}

/** A fresh copy of a fixture project and an empty HOME. */
export function makeSandbox(fixture: string | undefined = "full"): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "knowns-mcp-")));
  const dir = join(root, "project");
  const home = join(root, "home");
  mkdirSync(home);
  if (fixture) cpSync(join(FIXTURES, fixture), dir, { recursive: true });
  else mkdirSync(dir);
  return { dir, home };
}

// --- masking -------------------------------------------------------------------------------------

/** Replaces a path as it appears raw, JSON-escaped once and twice (Windows backslashes). */
export function maskPath(text: string, path: string, token: string): string {
  let out = text;
  let variant = path;
  for (let i = 0; i < 3; i++) {
    out = out.replaceAll(variant, token);
    variant = variant.replaceAll("\\", "\\\\");
  }
  return out.replaceAll(path.replaceAll("\\", "/"), token);
}

const RFC3339 = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;

/** What differs between two correct runs of the same session: wall-clock times, ids, hashes. */
export class Mask {
  private maps = { go: new Map<string, string>(), ts: new Map<string, string>() };
  extra: Array<[RegExp, string]> = [];

  constructor(
    private readonly dirs: { go: string; ts: string },
    private readonly homes: { go: string; ts: string },
  ) {}

  /** Mask a string for one side. */
  apply(side: Side, text: string): string {
    let out = maskPath(maskPath(text, this.dirs[side], "<DIR>"), this.homes[side], "<HOME>");
    // Both sandboxes live under the same tmp root with different random names.
    out = out.replace(RFC3339, "<TS>");
    out = out.replace(/\b[0-9a-f]{64}\b/g, "<HASH>");
    // Lifecycle event ids embed the wall clock in nanoseconds and a random suffix.
    out = out.replace(/:\d{19}:[0-9a-f]{16}/g, ":<EV>");
    // Time entry ids embed the wall clock in milliseconds.
    out = out.replace(/\bte-\d{13}-/g, "te-<MS>-");
    // Generated stable doc ids.
    out = out.replace(/\bdoc-[0-9a-f]{32}\b/g, "<DOCID>");
    for (const [re, to] of this.extra) out = out.replace(re, to);
    return out;
  }

  /** Normalise generated task ids (a per-side ordinal placeholder). */
  ids(side: Side, text: string, pattern: RegExp): string {
    const map = this.maps[side];
    return text.replace(pattern, (m) => {
      if (!map.has(m)) map.set(m, `<ID${map.size + 1}>`);
      return map.get(m) as string;
    });
  }
}

// --- differential sessions -----------------------------------------------------------------------

export interface DiffCtx {
  side: Side;
  /** Values captured by earlier steps, by name (differ per side). */
  v: Record<string, string>;
}

export interface Step {
  tool: string;
  args: Record<string, unknown> | ((c: DiffCtx) => Record<string, unknown>);
  /** Capture the first match (group 1, else the whole match) of the response text under `name`. */
  capture?: { name: string; re: RegExp };
  /** Do not compare (still run). */
  skipCompare?: boolean;
  /** Extra masking for this step's text. */
  normalize?: (text: string) => string;
  label?: string;
}

export interface DiffResult {
  label: string;
  go: ToolOut;
  ts: ToolOut;
  goMasked: string;
  tsMasked: string;
}

/** Runs the steps against Go and TS (each in its own copy of the fixture) and masks the output. */
export async function runDiff(
  fixture: string | undefined,
  steps: Step[],
  opts: { env?: Record<string, string>; setup?: (dir: string) => void } = {},
): Promise<{
  results: DiffResult[];
  go: Sandbox;
  ts: Sandbox;
  goSession: McpSession;
  tsSession: McpSession;
  close: () => Promise<void>;
}> {
  const go = makeSandbox(fixture);
  const ts = makeSandbox(fixture);
  opts.setup?.(go.dir);
  opts.setup?.(ts.dir);
  const goS = new McpSession("go", { cwd: go.dir, home: go.home, env: opts.env ?? {} });
  const tsS = new McpSession("ts", { cwd: ts.dir, home: ts.home, env: opts.env ?? {} });
  const mask = new Mask({ go: go.dir, ts: ts.dir }, { go: go.home, ts: ts.home });
  const caps: Record<Side, Record<string, string>> = { go: {}, ts: {} };
  await Promise.all([goS.initialize(), tsS.initialize()]);
  const results: DiffResult[] = [];
  const maskText = (side: Side, text: string, step: Step): string => {
    let out = mask.apply(side, text);
    for (const [name, value] of Object.entries(caps[side])) {
      if (value !== "") out = out.replaceAll(value, `<${name}>`);
    }
    return step.normalize ? step.normalize(out) : out;
  };
  for (const [i, step] of steps.entries()) {
    const argsFor = (side: Side) =>
      typeof step.args === "function" ? step.args({ side, v: caps[side] }) : step.args;
    const [g, t] = await Promise.all([
      goS.tool(step.tool, argsFor("go")),
      tsS.tool(step.tool, argsFor("ts")),
    ]);
    if (step.capture) {
      for (const [side, out] of [
        ["go", g],
        ["ts", t],
      ] as const) {
        const m = step.capture.re.exec(out.text);
        if (m) caps[side][step.capture.name] = m[1] ?? m[0];
      }
    }
    results.push({
      label: step.label ?? `${i}:${step.tool}:${JSON.stringify(argsFor("ts")).slice(0, 80)}`,
      go: g,
      ts: t,
      goMasked: `${g.isError ? "ERR " : ""}${maskText("go", g.text, step)}`,
      tsMasked: `${t.isError ? "ERR " : ""}${maskText("ts", t.text, step)}`,
    });
  }
  return {
    results,
    go,
    ts,
    goSession: goS,
    tsSession: tsS,
    close: async () => {
      await Promise.all([goS.close(), tsS.close()]);
    },
  };
}

/** The first differing lines of two texts, with a little context, for a readable failure. */
export function firstDiff(a: string, b: string): string {
  const x = a.split("\n");
  const y = b.split("\n");
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  const from = Math.max(0, i - 3);
  const ctx = (l: string[]) => l.slice(from, i + 6).join("\n");
  return `first difference at line ${i + 1}\nGO:\n${ctx(x)}\nTS:\n${ctx(y)}`;
}
