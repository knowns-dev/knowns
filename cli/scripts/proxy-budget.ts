// Spec mcp-thin-proxy D7 / NFR-1..3: the resource budget of the thin proxy, measured on the built
// binaries (cli/dist/<platform>/knowns[.exe] and knowns-proxy[.exe]) on macOS, Linux and Windows.
//   1. p95 of each tool through the proxy against the in-process engine (KNOWNS_MCP_PROXY=0)
//   2. N proxy sessions (and optionally the UI) under load, then idle: working set per process and
//      CPU, against the limits in proxy-budget.config.json
//   3. after every session closes: no knowns process, descriptor, socket or pipe remains
// Usage: bun scripts/proxy-budget.ts [--sessions N] [--ui | --ui-inproc] [--dir dist/<platform>] [--json out.json]
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cliDir = resolve(import.meta.dir, "..");
const cfg = JSON.parse(readFileSync(join(import.meta.dir, "proxy-budget.config.json"), "utf8"));
const argv = process.argv.slice(2);
const flag = (n: string) => argv.indexOf(`--${n}`);
const val = (n: string, d: string): string => (flag(n) >= 0 ? (argv[flag(n) + 1] ?? d) : d);
const isWin = process.platform === "win32";
const hosted = process.env.CI === "1" || process.env.CI === "true";
const limits = { ...cfg.limits, ...(hosted ? cfg.hosted : {}) };
const N = Number(val("sessions", String(cfg.sessions)));
const withUi = flag("ui") >= 0 || flag("ui-inproc") >= 0;
const platDir = val(
  "dir",
  `dist/${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`,
);
const bin = (n: string) => resolve(cliDir, platDir, isWin ? `${n}.exe` : n);
const KNOWNS = bin("knowns");
const PROXY = bin("knowns-proxy");
for (const f of [KNOWNS, PROXY])
  if (!existsSync(f)) throw new Error(`missing ${f}; run bun run build first`);

const failures: string[] = [];
const report: Record<string, unknown> = { limits, hosted };
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures.push(msg);
};

// ---- sandbox -----------------------------------------------------------------------------------
const base = mkdtempSync(join(tmpdir(), "kn-budget-"));
const home = join(base, "home");
const proj = join(base, "proj");
const rt = join(base, "rt");
for (const d of [home, proj, rt]) mkdirSync(d, { recursive: true });
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  KNOWNS_RUNTIME_ROOT: rt,
  KNOWNS_RUNTIME_IDLE_TIMEOUT_MS: String(cfg.daemonIdleTimeoutMs),
  KNOWNS_LSP_DAEMON: "0",
  KNOWNS_SEMANTIC_VECTOR_ENABLED: "false",
  NO_UPDATE_CHECK: "1",
};
delete env.KNOWNS_MCP_PROXY;
const run = (cmd: string[], e = env, cwd = proj) =>
  Bun.spawnSync(cmd, { cwd, env: e, stdout: "pipe", stderr: "pipe" });
{
  const e = { ...env, KNOWNS_MCP_PROXY: "0" };
  run(["git", "init", "-q", "."]);
  run([KNOWNS, "init", "budget"], e);
  for (let i = 1; i <= 30; i++)
    run([KNOWNS, "task", "create", `seed ${i}`, "-d", `seeded task ${i}`], e);
  for (let i = 1; i <= 5; i++)
    run([KNOWNS, "doc", "create", `Seed ${i}`, "-d", `seeded doc ${i}`], e);
}

// ---- process sampling (Windows: Get-Process, mac/linux: ps) -------------------------------------
interface Sample {
  pid: number;
  mb: number;
  cpuSec: number;
}
function sample(pids: number[]): Sample[] {
  if (pids.length === 0) return [];
  if (isWin) {
    const ps = `Get-Process -Id ${pids.join(",")} -EA SilentlyContinue | % { "$($_.Id) $($_.WorkingSet64) $($_.TotalProcessorTime.TotalSeconds)" }`;
    const out = Bun.spawnSync(["powershell", "-NoProfile", "-Command", ps]).stdout.toString();
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const [pid, ws, cpu] = l.trim().split(/\s+/);
        return { pid: Number(pid), mb: Number(ws) / 1048576, cpuSec: Number(cpu) };
      });
  }
  const out = Bun.spawnSync([
    "ps",
    "-o",
    "pid=,rss=,time=",
    "-p",
    pids.join(","),
  ]).stdout.toString();
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [pid, rss, time] = l.trim().split(/\s+/);
      const parts = (time ?? "0").split(/[:-]/).map(Number).reverse(); // [s, m, h, d]
      const cpuSec =
        (parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600 + (parts[3] ?? 0) * 86400;
      return { pid: Number(pid), mb: Number(rss) / 1024, cpuSec };
    });
}
const alive = (pid: number) => sample([pid]).length > 0;

// ---- MCP sessions ------------------------------------------------------------------------------
class Session {
  p!: ReturnType<typeof Bun.spawn>;
  got = new Map<number, number>(); // id -> arrival ms
  bad = 0;
  private buf = "";
  private n = 100;
  constructor(cmd: string[], e: Record<string, string>) {
    this.p = Bun.spawn(cmd, { cwd: proj, env: e, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    void (async () => {
      for await (const c of this.p.stdout as ReadableStream<Uint8Array>) {
        this.buf += new TextDecoder().decode(c);
        for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
          const l = this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          const m = /"id":(\d+)/.exec(l);
          if (m) {
            this.got.set(Number(m[1]), performance.now());
            if (l.includes('"error"') && !l.includes('"result"')) this.bad++;
          }
        }
      }
    })();
    this.send(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "budget", version: "1" },
    });
    (this.p.stdin as { write(s: string): void }).write(
      '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
    );
  }
  send(id: number, method: string, params: unknown) {
    (this.p.stdin as { write(s: string): number; flush(): void }).write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
  }
  async wait(id: number, ms = 30000) {
    const t = performance.now();
    while (performance.now() - t < ms) {
      const a = this.got.get(id);
      if (a !== undefined) return a;
      await Bun.sleep(5);
    }
    throw new Error(`no answer to ${id} within ${ms} ms`);
  }
  async call(name: string, args: Record<string, unknown>): Promise<number> {
    const id = ++this.n;
    const t = performance.now();
    this.send(id, "tools/call", { name, arguments: args });
    return (await this.wait(id)) - t;
  }
  async ready() {
    await this.wait(1, 60000);
  }
  async close() {
    try {
      (this.p.stdin as { end(): void }).end();
    } catch {}
    await Promise.race([this.p.exited, Bun.sleep(8000)]);
    this.p.kill();
  }
}
const proxySession = () =>
  new Session([PROXY, "mcp", "--stdio"], {
    ...env,
    KNOWNS_PROXY_KNOWNS_BIN: process.env.BUDGET_PROXY_KNOWNS ?? KNOWNS,
  });
const directSession = () =>
  new Session([KNOWNS, "mcp", "--stdio"], { ...env, KNOWNS_MCP_PROXY: "0" });

const TOOLS: Array<[string, Record<string, unknown>]> = [
  ["tasks", { action: "list" }],
  ["tasks", { action: "get", taskId: "1" }],
  ["docs", { action: "list" }],
  ["search", { query: "seed" }],
  ["project", { action: "current" }],
  ["help", { queries: ["tasks.*"] }],
];
const p95 = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * 0.95) - 1)] ?? 0;

// ---- 1. p95 against in-process -----------------------------------------------------------------
async function latency() {
  const rows: Record<string, { direct: number; proxy: number }> = {};
  const d = directSession();
  const p = proxySession();
  await Promise.all([d.ready(), p.ready()]);
  for (const [t, a] of TOOLS)
    for (const s of [d, p]) for (let i = 0; i < 5; i++) await s.call(t, a); // warm up
  for (const [t, a] of TOOLS) {
    const dl: number[] = [];
    const pl: number[] = [];
    for (let i = 0; i < 60; i++) {
      dl.push(await d.call(t, a));
      pl.push(await p.call(t, a));
    }
    const key = `${t}.${(a.action as string) ?? "call"}`;
    rows[key] = { direct: p95(dl), proxy: p95(pl) };
    const limit = rows[key].direct * limits.p95RatioMax + limits.p95SlackMs;
    check(
      rows[key].proxy <= limit,
      `p95 ${key}: proxy ${rows[key].proxy.toFixed(1)} ms vs in-process ${rows[key].direct.toFixed(1)} ms (limit ${limit.toFixed(1)} ms)`,
    );
  }
  report.p95 = rows;
  await Promise.all([d.close(), p.close()]);
  await Bun.sleep(1000);
}

// ---- 2. working set and idle CPU ---------------------------------------------------------------
function daemonPid(): number | undefined {
  const dir = join(rt, "mcp");
  if (!existsSync(dir)) return undefined;
  for (const f of (require("node:fs") as typeof import("node:fs")).readdirSync(dir))
    if (/^endpoint-.*\.json$/.test(f)) return JSON.parse(readFileSync(join(dir, f), "utf8")).pid;
  return undefined;
}
const tabAbort = new AbortController();
async function budget() {
  const ss = Array.from({ length: N }, proxySession);
  await Promise.all(ss.map((s) => s.ready()));
  let ui: ReturnType<typeof Bun.spawn> | undefined;
  if (withUi) {
    ui = Bun.spawn(
      [
        process.env.BUDGET_PROXY_KNOWNS ?? KNOWNS,
        "browser",
        "--no-open",
        "--port",
        "16420",
        "--project",
        proj,
      ],
      {
        cwd: proj,
        env: flag("ui-inproc") >= 0 ? { ...env, KNOWNS_MCP_PROXY: "0" } : env, // default: the daemon serves the UI (D6)
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    await Bun.sleep(4000);
    // Model a real open tab, not just a bound listener: /api/runtime/ps every 2 s and an SSE stream.
    const url = "http://127.0.0.1:16420";
    void fetch(`${url}/api/events`, { signal: tabAbort.signal })
      .then(async (r) => {
        for await (const _ of r.body as ReadableStream<Uint8Array>)
          if (tabAbort.signal.aborted) break;
      })
      .catch(() => {});
    void (async () => {
      while (!tabAbort.signal.aborted) {
        await fetch(`${url}/api/runtime/ps`, { signal: tabAbort.signal })
          .then((r) => r.text())
          .catch(() => {});
        await Bun.sleep(2000);
      }
    })();
  }
  const t0 = Date.now();
  let calls = 0;
  let k = 0;
  while (Date.now() - t0 < cfg.loadSeconds * 1000) {
    await Promise.all(
      ss.map((s, i) => {
        const [t, a] = TOOLS[(k + i) % TOOLS.length] as [string, Record<string, unknown>];
        calls++;
        return s.call(t, a);
      }),
    );
    k++;
    await Bun.sleep(50);
  }
  const dpid = daemonPid();
  check(dpid !== undefined, "a daemon descriptor exists while sessions are open");
  const proxies = ss.map((s) => s.p.pid);
  const all = [...proxies, ...(dpid ? [dpid] : []), ...(ui ? [ui.pid] : [])];
  const loaded = sample(all);
  const errs = ss.reduce((a, s) => a + s.bad, 0);
  check(errs === 0, `${calls} calls under load, ${errs} errors`);
  await Bun.sleep(2000);
  const c0 = sample(all);
  const w0 = performance.now();
  await Bun.sleep(Number(process.env.BUDGET_IDLE_SECONDS ?? cfg.idleSeconds) * 1000);
  const c1 = sample(all);
  const wall = (performance.now() - w0) / 1000;
  const cpuPct = (pid: number) => {
    const a = c0.find((x) => x.pid === pid);
    const b = c1.find((x) => x.pid === pid);
    return a && b ? ((b.cpuSec - a.cpuSec) / wall) * 100 : 0;
  };
  const peak = (pid: number) =>
    Math.max(loaded.find((x) => x.pid === pid)?.mb ?? 0, c1.find((x) => x.pid === pid)?.mb ?? 0);
  const rows = all.map((pid) => ({
    pid,
    role: pid === dpid ? "daemon" : pid === ui?.pid ? "ui" : "proxy",
    mb: peak(pid),
    idleCpu: cpuPct(pid),
  }));
  for (const r of rows)
    console.log(
      `     ${r.role.padEnd(6)} pid ${String(r.pid).padEnd(7)} ${r.mb.toFixed(1)} MB  idle cpu ${r.idleCpu.toFixed(2)}%`,
    );
  for (const r of rows.filter((x) => x.role === "proxy"))
    check(
      r.mb <= limits.proxyWorkingSetMB,
      `proxy ${r.pid} working set ${r.mb.toFixed(1)} MB <= ${limits.proxyWorkingSetMB}`,
    );
  const total = rows.reduce((a, r) => a + r.mb, 0);
  check(
    total <= limits.totalWorkingSetMB,
    `daemon + ${N} proxies${ui ? " + UI" : ""}: ${total.toFixed(1)} MB <= ${limits.totalWorkingSetMB}`,
  );
  const idle = rows.reduce((a, r) => a + r.idleCpu, 0);
  check(
    idle <= limits.idleCpuPercent,
    `idle CPU of all processes ${idle.toFixed(2)}% <= ${limits.idleCpuPercent}%`,
  );
  report.budget = { rows, totalMB: total, idleCpuPercent: idle, calls };
  // ---- 3. orphans after close ----
  const desc = existsSync(join(rt, "mcp"))
    ? (require("node:fs") as typeof import("node:fs"))
        .readdirSync(join(rt, "mcp"))
        .filter((f) => /^endpoint-.*\.json$/.test(f))
        .map((f) => JSON.parse(readFileSync(join(rt, "mcp", f), "utf8")))
    : [];
  await Promise.all(ss.map((s) => s.close()));
  tabAbort.abort();
  if (ui) ui.kill();
  const closedAt = Date.now();
  const deadline = closedAt + cfg.orphanWaitSeconds * 1000;
  const pids = all.filter((p) => p !== ui?.pid);
  while (Date.now() < deadline && sample(pids).length > 0) await Bun.sleep(500);
  const exitSec = (Date.now() - closedAt) / 1000;
  report.exitAfterCloseSec = exitSec;
  console.log(`     everything exited ${exitSec.toFixed(1)} s after the last session closed`);
  const left = sample(pids).map((x) => x.pid);
  check(
    left.length === 0,
    `no knowns or proxy process after close and the idle timeout${left.length ? ` (left: ${left})` : ""}`,
  );
  const mcpDir = join(rt, "mcp");
  const files = existsSync(mcpDir)
    ? (require("node:fs") as typeof import("node:fs"))
        .readdirSync(mcpDir)
        .filter((f) => /^endpoint-.*\.json$/.test(f))
    : [];
  check(files.length === 0, `no descriptor left${files.length ? ` (${files})` : ""}`);
  for (const d of desc) {
    if (d.kind === "unix_socket") check(!existsSync(d.address), `socket ${d.address} removed`);
    else {
      const pipe = String(d.address).split("\\").pop() as string;
      const out = Bun.spawnSync([
        "powershell",
        "-NoProfile",
        "-Command",
        `[IO.Directory]::GetFiles('\\\\.\\pipe\\') -contains '\\\\.\\pipe\\${pipe}'`,
      ])
        .stdout.toString()
        .trim();
      check(out !== "True", `pipe ${pipe} removed`);
    }
  }
}

try {
  await latency();
  await budget();
} finally {
  if (flag("json") >= 0)
    writeFileSync(
      val("json", "proxy-budget.json"),
      JSON.stringify({ ...report, failures }, null, 2),
    );
}
console.log(failures.length ? `\n${failures.length} budget check(s) failed` : "\nproxy budget ok");
process.exit(failures.length ? 1 : 0);
