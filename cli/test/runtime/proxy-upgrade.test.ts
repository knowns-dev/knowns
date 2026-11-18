// Spec mcp-thin-proxy D3 upgrade scenario, with real processes: two versions of knowns (bun
// --define KNOWNS_VERSION) and two native proxies built with -X main.version. A session opened on
// the old version keeps its daemon and keeps working while a session of the new version gets its
// own daemon; when the old session closes the old daemon exits and the new one is untouched.
// Needs Go and a Unix shell (the knowns "binary" the proxy launches is a wrapper script).
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDescriptor } from "../../src/runtime/mcp-endpoint.ts";

const CLI_ROOT = join(import.meta.dir, "..", "..");
const PROXY_SRC = join(CLI_ROOT, "..", "proxy");
const hasGo = Bun.spawnSync(["go", "version"]).exitCode === 0;
const canRun = hasGo && process.platform !== "win32" && existsSync(PROXY_SRC);

const base = realpathSync(mkdtempSync(join(tmpdir(), "kn-upg-")));
const home = join(base, "home");
const runtime = join(base, "rt");
const proj = join(base, "proj");
for (const d of [home, runtime, proj]) mkdirSync(d);
mkdirSync(join(proj, ".knowns"));

function build(version: string): { proxy: string; knowns: string } {
  // A release launcher takes no engine from the environment: each version is an install of its own,
  // `knowns` (the launcher) with a `knowns-engine` beside it.
  const dir = join(base, `install-${version}`);
  mkdirSync(dir);
  const proxy = join(dir, "knowns");
  const r = Bun.spawnSync(
    ["go", "build", "-ldflags", `-X main.version=${version}`, "-o", proxy, "."],
    {
      cwd: PROXY_SRC,
      env: { ...process.env, CGO_ENABLED: "0" },
    },
  );
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  const knowns = join(dir, "knowns-engine");
  writeFileSync(
    knowns,
    `#!/bin/sh\nexec "${process.execPath}" --define 'KNOWNS_VERSION="${version}"' "${join(CLI_ROOT, "src", "main.ts")}" "$@"\n`,
  );
  chmodSync(knowns, 0o755);
  return { proxy, knowns };
}

const env = (knowns: string) => ({
  PATH: process.env.PATH ?? "",
  HOME: home,
  USERPROFILE: home,
  KNOWNS_RUNTIME_ROOT: runtime,
  KNOWNS_RUNTIME_IDLE_TIMEOUT_MS: "1500",
  KNOWNS_RUNTIME_WATCH_ENABLED: "0",
  KNOWNS_LSP_DAEMON: "0",
  NO_UPDATE_CHECK: "1",
  CI: "1",
});

class Sess {
  p!: ReturnType<typeof Bun.spawn>;
  out = "";
  constructor(proxy: string, knowns: string) {
    this.p = Bun.spawn([proxy, "mcp", "--stdio"], {
      cwd: proj,
      env: env(knowns),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    void (async () => {
      for await (const c of this.p.stdout as ReadableStream<Uint8Array>)
        this.out += new TextDecoder().decode(c);
    })();
    this.send(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
  }
  send(id: number, method: string, params: unknown) {
    (this.p.stdin as { write(s: string): number; flush(): void }).write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
  }
  async answer(id: number, ms = 30_000): Promise<string> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const l = this.out
        .split("\n")
        .find((x) => x.includes(`"id":${id},`) || x.includes(`"id":${id}}`));
      if (l) return l;
      await Bun.sleep(50);
    }
    throw new Error(`no answer ${id}`);
  }
  async close() {
    (this.p.stdin as { end(): void }).end();
    await Promise.race([this.p.exited, Bun.sleep(8000)]);
    this.p.kill();
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until<T>(f: () => T | undefined | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(100);
  }
}

describe.skipIf(!canRun)("upgrade with sessions open (D3)", () => {
  const open: Sess[] = [];
  afterAll(async () => {
    for (const s of open) await s.close();
  });

  test("old sessions stay on the old daemon, new ones get the new daemon, the old one exits", async () => {
    const v1 = build("1.0.0");
    const v2 = build("2.0.0");
    const a = new Sess(v1.proxy, v1.knowns);
    const b = new Sess(v1.proxy, v1.knowns);
    open.push(a, b);
    await a.answer(1);
    await b.answer(1);
    const d1 = await until(() => readDescriptor("1.0.0", runtime));
    expect(d1.version).toBe("1.0.0");

    // The upgrade lands: a new session runs the new proxy while both old ones are open.
    const c = new Sess(v2.proxy, v2.knowns);
    open.push(c);
    await c.answer(1);
    const d2 = await until(() => readDescriptor("2.0.0", runtime));
    expect(d2.pid).not.toBe(d1.pid);
    expect(alive(d1.pid)).toBe(true);

    // Old sessions keep working on the old daemon; the new one works on the new daemon.
    for (const [s, id] of [
      [a, 2],
      [b, 2],
      [c, 2],
    ] as const) {
      s.send(id, "tools/call", { name: "project", arguments: { action: "current" } });
      expect(await s.answer(id)).not.toContain('"error"');
    }
    expect(readDescriptor("1.0.0", runtime)?.pid).toBe(d1.pid);

    // The old sessions end: the old daemon exits after its own last session, the new one stays.
    await a.close();
    expect(alive(d1.pid)).toBe(true); // b still holds it
    await b.close();
    await until(() => !alive(d1.pid), 60_000);
    expect(readDescriptor("1.0.0", runtime)).toBeUndefined();
    expect(alive(d2.pid)).toBe(true);
    c.send(3, "tools/call", { name: "project", arguments: { action: "current" } });
    expect(await c.answer(3)).not.toContain('"error"');
    await c.close();
    await until(() => !alive(d2.pid), 60_000);
  }, 180_000);
});
