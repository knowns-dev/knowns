// The two binaries the rollback test drives, both as subprocesses with an explicit temp HOME:
// - the RELEASED Go 0.34.1 (never a source build): KNOWNS_034_BIN, or the GitHub release asset
//   downloaded once into <tmpdir>/knowns-rollback-cache/0.34.1/<platform> and sha256-verified;
// - the TypeScript CLI: KNOWNS_TS_BIN (a compiled binary), else `bun src/main.ts`.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const RELEASE = "0.34.1";
const MAIN = resolve(import.meta.dir, "..", "..", "src", "main.ts");

/** Release assets each version did NOT publish (0.34.1: no win-arm64; 0.25.0: no darwin-x64 either). */
const MISSING_ASSETS: Record<string, string[]> = {
  "0.34.1": ["win-arm64"],
  "0.25.0": ["win-arm64", "darwin-x64"],
};

/** The asset suffix the given release published for this host, or undefined. */
export function releasePlatform(version = RELEASE): string | undefined {
  const os = { darwin: "darwin", linux: "linux", win32: "win" }[process.platform as string];
  const arch = { arm64: "arm64", x64: "x64" }[process.arch as string];
  if (!os || !arch) return undefined;
  const p = `${os}-${arch}`;
  return (MISSING_ASSETS[version] ?? []).includes(p) ? undefined : p;
}

/**
 * Path to a RELEASED Go binary (default 0.34.1), downloading it on first use. KNOWNS_034_BIN
 * (or KNOWNS_025_BIN for 0.25.0) points at a local copy instead. Throws with the reason when it
 * cannot be obtained.
 */
export async function releasedGo(version = RELEASE): Promise<string> {
  const override =
    process.env[`KNOWNS_${version.split(".").slice(0, 2).join("").padStart(3, "0")}_BIN`];
  if (override) {
    if (!existsSync(override))
      throw new Error(`override for ${version} does not exist: ${override}`);
    return resolve(override);
  }
  const platform = releasePlatform(version);
  if (!platform)
    throw new Error(`no ${version} release asset for ${process.platform}-${process.arch}`);
  const exe = process.platform === "win32" ? "knowns.exe" : "knowns";
  // The real tmpdir, not the sandboxed HOME, so the download is shared across runs.
  const dir = join(tmpdir(), "knowns-rollback-cache", version, platform);
  const bin = join(dir, exe);
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  const base = `https://github.com/knowns-dev/knowns/releases/download/v${version}/knowns-${platform}.tar.gz`;
  const [archive, sum] = await Promise.all([fetchBytes(base), fetchBytes(`${base}.sha256`)]);
  const expected = new TextDecoder().decode(sum).trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected)
    throw new Error(`checksum mismatch for ${base}: ${actual} != ${expected}`);
  const tgz = join(dir, "asset.tar.gz");
  writeFileSync(tgz, archive);
  const stage = join(dir, "stage");
  mkdirSync(stage, { recursive: true });
  const r = Bun.spawnSync(["tar", "-xzf", tgz, "-C", stage], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`extract ${tgz}: ${r.stderr.toString()}`);
  renameSync(join(stage, exe), bin);
  if (process.platform !== "win32") chmodSync(bin, 0o755);
  return bin;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export interface Side {
  name: "go" | "ts";
  cmd: string[];
}

export function tsSide(): Side {
  const bin = process.env.KNOWNS_TS_BIN;
  return { name: "ts", cmd: bin ? [resolve(bin)] : [process.execPath, MAIN] };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one CLI call with only the given env (plus PATH and the OS basics a process needs). */
export function run(
  side: Side,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): RunResult {
  const base: Record<string, string> = { PATH: process.env.PATH ?? "" };
  for (const k of [
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LOCALAPPDATA",
    "APPDATA",
    "windir",
    "ComSpec",
    "PATHEXT",
  ]) {
    const v = process.env[k];
    if (v) base[k] = v;
  }
  const r = Bun.spawnSync([...side.cmd, ...args], {
    cwd,
    env: { ...base, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

/** Like run, but throws with the output when the command fails. */
export function must(side: Side, args: string[], cwd: string, env: Record<string, string>): string {
  const r = run(side, args, cwd, env);
  if (r.code !== 0) {
    throw new Error(`${side.name} ${args.join(" ")} exited ${r.code}:\n${r.stdout}${r.stderr}`);
  }
  return r.stdout;
}

/** A minimal MCP stdio client for `knowns mcp --stdio` (newline-delimited JSON-RPC). */
export class McpClient {
  private proc: ReturnType<typeof Bun.spawn>;
  private buf = "";
  private nextId = 1;
  private waiters = new Map<number, (msg: Record<string, unknown>) => void>();

  constructor(side: Side, cwd: string, env: Record<string, string>) {
    const base: Record<string, string> = { PATH: process.env.PATH ?? "" };
    for (const k of [
      "SystemRoot",
      "TEMP",
      "TMP",
      "TMPDIR",
      "LOCALAPPDATA",
      "APPDATA",
      "windir",
      "ComSpec",
      "PATHEXT",
    ]) {
      const v = process.env[k];
      if (v) base[k] = v;
    }
    this.proc = Bun.spawn([...side.cmd, "mcp", "--stdio"], {
      cwd,
      env: { ...base, ...env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    void this.pump();
  }

  private async pump(): Promise<void> {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      this.buf += dec.decode(value, { stream: true });
      let nl = this.buf.indexOf("\n");
      while (nl >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (line !== "") {
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            const id = msg.id as number | undefined;
            if (id !== undefined && this.waiters.has(id)) {
              (this.waiters.get(id) as (m: Record<string, unknown>) => void)(msg);
              this.waiters.delete(id);
            }
          } catch {
            // not JSON-RPC
          }
        }
        nl = this.buf.indexOf("\n");
      }
    }
  }

  request(method: string, params: unknown, timeoutMs = 60_000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const stdin = this.proc.stdin as { write(s: string): void; flush?(): void };
    return new Promise((resolvePromise, reject) => {
      const t = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), timeoutMs);
      this.waiters.set(id, (m) => {
        clearTimeout(t);
        resolvePromise(m);
      });
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      stdin.flush?.();
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "rollback-034", version: "1" },
    });
    (this.proc.stdin as { write(s: string): void }).write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
  }

  /** tools/call; returns the first text content, throwing on a JSON-RPC or tool error. */
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const msg = await this.request("tools/call", { name, arguments: args });
    if (msg.error)
      throw new Error(`MCP ${name} ${JSON.stringify(args)}: ${JSON.stringify(msg.error)}`);
    const result = msg.result as { content?: { text?: string }[]; isError?: boolean };
    const text = result?.content?.[0]?.text ?? "";
    if (result?.isError) throw new Error(`MCP ${name} ${JSON.stringify(args)} isError: ${text}`);
    return text;
  }

  async close(): Promise<void> {
    try {
      (this.proc.stdin as { end(): void }).end();
    } catch {
      // already closed
    }
    const exited = this.proc.exited;
    const timer = setTimeout(() => this.proc.kill(), 5_000);
    await exited;
    clearTimeout(timer);
  }
}

/** sha256 of a file, for before/after comparisons. */
export function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
