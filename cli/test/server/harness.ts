// Go-vs-TypeScript differential harness for `knowns browser`: the same HTTP requests go to the
// Go 0.34.1 server and the TS server, each in its own copy of one seeded project and its own HOME.
// Only what Go makes nondeterministic is masked (see mask()): wall-clock timestamps, hashes chained
// over them, generated ids, and the absolute directories of each side. Bodies are compared as raw
// text after masking, so key order and spacing differences fail too.
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GO_BIN, hasGoBin } from "../cli/oracle.ts";

export { GO_BIN, hasGoBin };

const MAIN = join(import.meta.dir, "..", "..", "src", "main.ts");

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else reject(new Error("no port"));
    });
    srv.on("error", reject);
  });
}

export function testEnv(home: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: "1",
    NO_UPDATE_CHECK: "1",
    KNOWNS_RUNTIME_INLINE: "1",
    KNOWN_RUNTIME_INLINE: "1",
    KNOWN_LSP_AUTO_INSTALL: "0",
    KNOWN_LSP_DAEMON: "0",
    KNOWNS_SEMANTIC_VECTOR_ENABLED: "false",
  };
}

export interface Side {
  name: "go" | "ts";
  root: string;
  dir: string;
  home: string;
  port: number;
  base: string;
  proc?: ReturnType<typeof Bun.spawn>;
  /** server-specific values replaced by placeholders: [value, placeholder] */
  subs: [string, string][];
}

/** Seed one project with the Go binary, then copy it so both sides start byte-identical. */
export function seedTemplate(): string {
  const root = mkdtempSync(join(tmpdir(), "knowns-srv-tpl-"));
  const dir = join(root, "proj");
  const home = join(root, "home");
  mkdirSync(dir);
  mkdirSync(home);
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  const r = Bun.spawnSync([GO_BIN as string, "init", "Probe", "--no-wizard", "--no-open"], {
    cwd: dir,
    env: testEnv(home),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`go init failed: ${r.stderr.toString()}`);
  return dir;
}

export async function startSide(
  name: "go" | "ts",
  template: string,
  extra: { args?: string[]; env?: Record<string, string> } = {},
): Promise<Side> {
  const root = mkdtempSync(join(tmpdir(), `knowns-srv-${name}-`));
  const dir = join(root, "proj");
  const home = join(root, "home");
  mkdirSync(home);
  cpSync(template, dir, { recursive: true });
  const port = await freePort();
  const cmd =
    name === "go"
      ? [GO_BIN as string, "browser", "--port", String(port), "--no-open", ...(extra.args ?? [])]
      : ["bun", MAIN, "browser", "--port", String(port), "--no-open", ...(extra.args ?? [])];
  const proc = Bun.spawn(cmd, {
    cwd: dir,
    env: { ...testEnv(home), ...(extra.env ?? {}) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const side: Side = {
    name,
    root,
    dir,
    home,
    port,
    base: `http://127.0.0.1:${port}`,
    proc,
    subs: [],
  };
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`${side.base}/api/config`);
      if (res.status > 0) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${name} server did not start`);
    await Bun.sleep(100);
  }
  return side;
}

export function stopSide(s: Side): void {
  s.proc?.kill();
}

export interface Reply {
  status: number;
  headers: Record<string, string>;
  text: string;
}

const KEEP_HEADERS = [
  "content-type",
  "location",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-max-age",
  "vary",
  "set-cookie",
  "x-content-type-options",
  "accept-ranges",
  "content-range",
  "cache-control",
];

export async function send(
  side: Side,
  method: string,
  path: string,
  opts: { body?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const res = await fetch(`${side.base}${path}`, {
    method,
    headers: opts.headers,
    body: opts.body,
    redirect: "manual",
  });
  const headers: Record<string, string> = {};
  for (const k of KEEP_HEADERS) {
    const v = res.headers.get(k);
    if (v !== null) headers[k] = v;
  }
  return { status: res.status, headers, text: await res.text() };
}

const TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;

/** The only rewriting: see the file header. */
export function mask(text: string, side: Side): string {
  let out = text;
  for (const [value, placeholder] of side.subs) out = out.split(value).join(placeholder);
  // JSON escapes Windows backslashes, and Windows reports the on-disk casing of a path.
  const swap = (value: string, placeholder: string): void => {
    for (const v of [JSON.stringify(value).slice(1, -1), value]) {
      const re = new RegExp(
        v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        process.platform === "win32" ? "gi" : "g",
      );
      out = out.replace(re, placeholder);
    }
  };
  swap(side.dir, "<PROJ>");
  swap(side.root, "<ROOT>");
  swap(side.home, "<HOME>");
  // macOS resolves /var -> /private/var in some paths
  out = out.replace(/\/private(?=<)/g, "");
  out = out.replace(TS_RE, "<TS>");
  out = out.replace(/\b[0-9a-f]{64}\b/g, "<HASH>");
  out = out.replace(/doc-[0-9a-f]{32}/g, "<DOCID>");
  out = out.replace(/te-\d+-/g, "te-<N>-");
  out = out.replace(/"totalPausedMs":\d+/g, '"totalPausedMs":<N>');
  out = out.replace(/"timestamp":\d{10,}/g, '"timestamp":<MS>');
  return out;
}

export function maskHeaders(h: Record<string, string>, side: Side): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) o[k] = mask(v, side);
  return o;
}

export function writeArtifact(name: string, content: string): void {
  writeFileSync(join(tmpdir(), name), content);
}
