// Spec mcp-thin-proxy D10 in `knowns update`: a launcher archive (layout.json) installs the
// launcher as knowns and the engine as knowns-engine as one unit; an install an older updater left
// as the engine alone is finished by `knowns update` even on the latest version; an archive without
// a launcher still installs the engine alone. Runs in-process against updateSeams, a local HTTP
// server and an isolated HOME, like update.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSeams } from "../../../src/cli/commands/update.ts";
import {
  isLegacyLayout,
  layoutHint,
  parseArchiveLayout,
} from "../../../src/domain/update/layout.ts";
import { VERSION } from "../../../src/version.ts";
import { withProcessEnv } from "../../helpers/process-env.ts";
import { runTs } from "../oracle.ts";

const SLOW = 120_000;
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI styling
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function tarball(files: Record<string, string>, links: Record<string, string> = {}): Uint8Array {
  const src = tmp("knowns-d10-src-");
  for (const [n, c] of Object.entries(files)) writeFileSync(join(src, n), c);
  for (const [n, target] of Object.entries(links)) {
    Bun.spawnSync(["ln", join(src, target), join(src, n)]);
  }
  const out = join(tmp("knowns-d10-out-"), "a.tar.gz");
  const members = [...Object.keys(files), ...Object.keys(links)].map((n) => `./${n}`);
  const r = Bun.spawnSync(["tar", "-czf", out, "-C", src, ...members]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return new Uint8Array(readFileSync(out));
}

const latest = "99.0.0";
let server: ReturnType<typeof Bun.serve>;
let d10: Uint8Array;
let old: Uint8Array;
let oldWin: Uint8Array;
beforeAll(() => {
  d10 = tarball(
    {
      knowns: "NEW-ENGINE",
      "knowns.launcher": "NEW-LAUNCHER",
      "layout.json": JSON.stringify({
        layout: 1,
        version: latest,
        launcher: { file: "knowns.launcher", installAs: "knowns" },
        engine: { file: "knowns", installAs: "knowns-engine" },
      }),
    },
    { "knowns-engine": "knowns" },
  );
  old = tarball({ knowns: "NEW-ENGINE-ONLY" });
  oldWin = tarball({ "knowns.exe": "NEW-ENGINE-ONLY" });
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const body = path.startsWith("/d10") ? d10 : path.startsWith("/oldwin") ? oldWin : old;
      if (path.endsWith(".sha256")) return new Response(`${sha256(body)}  x.tar.gz\n`);
      return new Response(body);
    },
  });
});
afterAll(() => server.stop(true));
const base = (): string => `http://127.0.0.1:${server.port}`;

function sandbox(files: Record<string, string>, extraEnv: Record<string, string> = {}) {
  const home = tmp("knowns-d10-home-");
  const project = tmp("knowns-d10-proj-");
  const bin = join(home, ".knowns", "bin");
  mkdirSync(bin, { recursive: true });
  for (const [n, c] of Object.entries(files)) {
    writeFileSync(join(bin, n), c);
    chmodSync(join(bin, n), 0o755);
  }
  writeFileSync(
    join(home, ".knowns", "install.json"),
    JSON.stringify({
      method: "script",
      managedBy: "knowns-script",
      updateStrategy: "self-update",
      binaryPath: join(bin, "knowns"),
    }),
  );
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    NO_UPDATE_CHECK: "1",
    CI: "1",
    KNOWNS_RUNTIME_INLINE: "1",
    ...extraEnv,
  };
  return { home, project, bin, env };
}

const saved = { ...updateSeams };
function seams(overrides: Partial<typeof updateSeams>): void {
  Object.assign(updateSeams, saved, {
    fetchLatest: async () => latest,
    isTTY: () => false,
    goos: () => "linux",
    restartRuntime: async () => {},
    run: async () => {
      throw new Error("unstubbed run");
    },
    ...overrides,
  });
}
const restore = () => Object.assign(updateSeams, saved);

async function update(sb: ReturnType<typeof sandbox>) {
  const r = await withProcessEnv(
    sb.env,
    () => runTs(["update"], { cwd: sb.project, env: sb.env }),
    {
      keepPath: true,
    },
  );
  return { ...r, stdout: plain(r.stdout), stderr: plain(r.stderr) };
}
const read = (p: string) => readFileSync(p, "utf8");
const stray = (dir: string) => readdirSync(dir).filter((n) => /\.(tmp|rollback|new)/.test(n));

describe("update with a launcher archive", () => {
  test(
    "an old-layout install (the engine alone as knowns) ends split: launcher + engine, retired proxy gone",
    async () => {
      const sb = sandbox({ knowns: "OLD-ENGINE", "knowns-proxy": "OLD-PROXY" });
      seams({ executable: () => join(sb.bin, "knowns"), releaseUrl: () => `${base()}/d10.tar.gz` });
      try {
        const r = await update(sb);
        expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" });
        expect(r.stdout).toContain("Upgrade complete.");
        expect(read(join(sb.bin, "knowns"))).toBe("NEW-LAUNCHER");
        expect(read(join(sb.bin, "knowns-engine"))).toBe("NEW-ENGINE");
        expect(existsSync(join(sb.bin, "knowns-proxy"))).toBe(false);
        expect(existsSync(join(sb.bin, "layout.json"))).toBe(false);
        expect(existsSync(join(sb.bin, "knowns.launcher"))).toBe(false);
        expect(stray(sb.bin)).toEqual([]);
      } finally {
        restore();
      }
    },
    SLOW,
  );

  test(
    "run from the engine (KNOWNS_LAUNCHER set) the launcher path is knowns, not knowns-engine",
    async () => {
      const sb = sandbox(
        { knowns: "OLD-LAUNCHER", "knowns-engine": "OLD-ENGINE" },
        {
          KNOWNS_LAUNCHER: "",
        },
      );
      sb.env.KNOWNS_LAUNCHER = join(sb.bin, "knowns");
      // The sandbox metadata may even name the engine (inferred metadata does).
      writeFileSync(
        join(sb.home, ".knowns", "install.json"),
        JSON.stringify({
          method: "script",
          managedBy: "knowns-script",
          updateStrategy: "self-update",
          binaryPath: join(sb.bin, "knowns-engine"),
        }),
      );
      seams({
        executable: () => join(sb.bin, "knowns-engine"),
        releaseUrl: () => `${base()}/d10.tar.gz`,
      });
      try {
        const r = await update(sb);
        expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" });
        expect(read(join(sb.bin, "knowns"))).toBe("NEW-LAUNCHER");
        expect(read(join(sb.bin, "knowns-engine"))).toBe("NEW-ENGINE");
        const meta = JSON.parse(read(join(sb.home, ".knowns", "install.json")));
        expect(meta.binaryPath).toBe(join(sb.bin, "knowns"));
      } finally {
        restore();
      }
    },
    SLOW,
  );

  test(
    "already on the latest version, an old-layout install is still split",
    async () => {
      const sb = sandbox({ knowns: "OLD-ENGINE" });
      seams({
        fetchLatest: async () => VERSION,
        executable: () => join(sb.bin, "knowns"),
        releaseUrl: () => `${base()}/d10.tar.gz`,
      });
      try {
        const r = await update(sb);
        expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" });
        expect(r.stdout).toContain("old single-binary layout");
        expect(read(join(sb.bin, "knowns"))).toBe("NEW-LAUNCHER");
        expect(read(join(sb.bin, "knowns-engine"))).toBe("NEW-ENGINE");
      } finally {
        restore();
      }
    },
    SLOW,
  );

  test(
    "already on the latest version, a split install is left alone; --check only says what it would do",
    async () => {
      const sb = sandbox(
        { knowns: "LAUNCHER", "knowns-engine": "ENGINE" },
        { KNOWNS_LAUNCHER: "x" },
      );
      seams({
        fetchLatest: async () => VERSION,
        executable: () => join(sb.bin, "knowns-engine"),
        releaseUrl: () => `${base()}/d10.tar.gz`,
      });
      try {
        const r = await update(sb);
        expect(r.stdout).toContain("Already on the latest version");
        expect(read(join(sb.bin, "knowns"))).toBe("LAUNCHER");
      } finally {
        restore();
      }
      const legacy = sandbox({ knowns: "OLD-ENGINE" });
      seams({
        fetchLatest: async () => VERSION,
        executable: () => join(legacy.bin, "knowns"),
        releaseUrl: () => `${base()}/d10.tar.gz`,
      });
      try {
        const r = await withProcessEnv(
          legacy.env,
          () => runTs(["update", "--check"], { cwd: legacy.project, env: legacy.env }),
          { keepPath: true },
        );
        expect(plain(r.stdout)).toContain("knowns update");
        expect(read(join(legacy.bin, "knowns"))).toBe("OLD-ENGINE");
      } finally {
        restore();
      }
    },
    SLOW,
  );

  test(
    "an archive without a launcher installs the engine alone and drops knowns-engine",
    async () => {
      const sb = sandbox({ knowns: "LAUNCHER", "knowns-engine": "ENGINE" });
      seams({ executable: () => join(sb.bin, "knowns"), releaseUrl: () => `${base()}/old.tar.gz` });
      try {
        const r = await update(sb);
        expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" });
        expect(read(join(sb.bin, "knowns"))).toBe("NEW-ENGINE-ONLY");
        expect(existsSync(join(sb.bin, "knowns-engine"))).toBe(false);
        // recorded, so that an update at the same version does not fetch this archive again
        expect(JSON.parse(read(join(sb.home, ".knowns", "install.json"))).layout).toBe("single");
      } finally {
        restore();
      }
    },
    SLOW,
  );

  test(
    "an archive without a launcher also replaces the kn.exe launcher copy on Windows",
    async () => {
      const sb = sandbox({
        "knowns.exe": "LAUNCHER",
        "kn.exe": "LAUNCHER",
        "knowns-engine.exe": "ENGINE",
      });
      const meta = join(sb.home, ".knowns", "install.json");
      writeFileSync(
        meta,
        JSON.stringify({ ...JSON.parse(read(meta)), binaryPath: join(sb.bin, "knowns.exe") }),
      );
      seams({
        goos: () => "windows",
        executable: () => join(sb.bin, "knowns.exe"),
        releaseUrl: () => `${base()}/oldwin.tar.gz`,
      });
      try {
        const r = await update(sb);
        expect({ code: r.code, out: r.stdout.slice(-300), err: r.stderr }).toMatchObject({
          code: 0,
        });
        expect(read(join(sb.bin, "knowns.exe"))).toBe("NEW-ENGINE-ONLY");
        expect(read(join(sb.bin, "kn.exe"))).toBe("NEW-ENGINE-ONLY");
        expect(existsSync(join(sb.bin, "knowns-engine.exe"))).toBe(false);
      } finally {
        restore();
      }
    },
    SLOW,
  );

  test(
    "at the same version a layout=single install is not finished again",
    async () => {
      const sb = sandbox({ knowns: "ENGINE-ONLY" });
      const meta = join(sb.home, ".knowns", "install.json");
      writeFileSync(meta, JSON.stringify({ ...JSON.parse(read(meta)), layout: "single" }));
      let downloads = 0;
      seams({
        fetchLatest: async () => VERSION,
        executable: () => join(sb.bin, "knowns"),
        releaseUrl: () => {
          downloads++;
          return `${base()}/old.tar.gz`;
        },
      });
      try {
        const r = await update(sb);
        expect(r.stdout).toContain("Already on the latest version");
        expect(downloads).toBe(0);
      } finally {
        restore();
      }
    },
    SLOW,
  );
});

describe("layout detection and the hint", () => {
  test("legacy means a compiled knowns that no launcher started", () => {
    expect(isLegacyLayout("/x/bin/knowns", {})).toBe(true);
    expect(isLegacyLayout("C:\\k\\knowns.exe", {})).toBe(true);
    expect(isLegacyLayout("/x/bin/knowns-engine", {})).toBe(false);
    const mine = {
      execPath: "/x/bin/knowns-engine",
      platform: "linux",
      realpath: (p: string) => p,
    };
    expect(isLegacyLayout("/x/bin/knowns", { KNOWNS_LAUNCHER: "/x/bin/knowns" }, mine)).toBe(false);
    // a KNOWNS_LAUNCHER that is not the launcher of this engine is no launcher at all
    expect(isLegacyLayout("/x/bin/knowns", { KNOWNS_LAUNCHER: "/tmp/evil" }, mine)).toBe(true);
    expect(isLegacyLayout("/usr/local/bin/bun", {})).toBe(false);
  });

  test("layout.json parsing rejects an unknown layout and names with a path", () => {
    const good = {
      layout: 1,
      version: "1",
      launcher: { file: "a", installAs: "knowns" },
      engine: { file: "knowns", installAs: "knowns-engine" },
    };
    expect(parseArchiveLayout(JSON.stringify(good)).engine.installAs).toBe("knowns-engine");
    expect(() => parseArchiveLayout(JSON.stringify({ ...good, layout: 2 }))).toThrow("newer");
    expect(() =>
      parseArchiveLayout(JSON.stringify({ ...good, launcher: { file: "../a", installAs: "k" } })),
    ).toThrow("no launcher");
    expect(() => parseArchiveLayout("{")).toThrow("not valid JSON");
  });

  test("the hint shows at most once a day, only on an interactive legacy install", () => {
    const home = tmp("knowns-hint-home-");
    let now = 1_700_000_000_000;
    const base = {
      exe: "/x/bin/knowns",
      env: { HOME: home, USERPROFILE: home } as Record<string, string>,
      isTTY: true,
      stdinTTY: true,
      now: () => now,
    };
    expect(layoutHint(["task", "list"], { ...base, isTTY: false })).toBe("");
    expect(layoutHint(["task", "list"], { ...base, stdinTTY: false })).toBe("");
    expect(layoutHint(["mcp", "--stdio"], base)).toBe("");
    for (const quiet of ["--json", "--plain", "update", "doctor"]) {
      expect(layoutHint(["task", "list", quiet], base)).toBe("");
    }
    // machine output spelled with a value: --flag=value, -o json, --format json
    for (const args of [
      ["task", "list", "--json=true"],
      ["task", "list", "--plain=true"],
      ["task", "list", "-o", "json"],
      ["task", "list", "--format", "json"],
      ["task", "list", "--output=yaml"],
    ]) {
      expect(layoutHint(args, base)).toBe("");
    }
    expect(layoutHint(["task", "list"], { ...base, exe: "/x/bin/knowns-engine" })).toBe("");
    expect(layoutHint(["task", "list"], { ...base, env: { ...base.env, CI: "1" } })).toBe("");
    // none of the above consumed the once-a-day allowance
    expect(layoutHint(["task", "list"], base)).toContain("knowns update");
    expect(layoutHint(["task", "list"], base)).toBe("");
    now += 23 * 3_600_000;
    expect(layoutHint(["task", "list"], base)).toBe("");
    now += 2 * 3_600_000;
    expect(layoutHint(["task", "list"], base)).toContain("knowns update");
  });
});

describe("knowns doctor", () => {
  test("reports the old layout and names knowns update; a split install adds no check", async () => {
    const { proxyCheckers } = await import("../../../src/domain/doctor/proxy-checks.ts");
    const input = { proxyEnabled: true, reports: [], fallbacks: [], proxyNamedEntries: [] };
    expect(proxyCheckers(input)).toEqual([]);
    const checks = proxyCheckers({ ...input, legacyLayout: true });
    expect(checks.map((c) => c.id)).toEqual(["runtime.layout"]);
    const out = await checks[0]?.check({} as never);
    expect(out).toMatchObject({
      status: "warn",
      summary: expect.stringContaining("old layout"),
      remediation: { command: "knowns update" },
    });
  });
});

describe("single-binary releases and the npm installer share one layout.json rule", () => {
  test("an install that recorded layout=single is not hinted at and not finished again", () => {
    const home = tmp("knowns-hint-single-");
    mkdirSync(join(home, ".knowns"), { recursive: true });
    writeFileSync(
      join(home, ".knowns", "install.json"),
      JSON.stringify({ method: "script", layout: "single" }),
    );
    const seams = {
      exe: "/x/bin/knowns",
      env: { HOME: home, USERPROFILE: home } as Record<string, string>,
      isTTY: true,
      stdinTTY: true,
    };
    expect(layoutHint(["task", "list"], seams)).toBe("");
  });

  test("npm install.js parseArchiveLayout accepts and rejects exactly what update.ts does", () => {
    // biome-ignore lint/style/noCommonJs: the npm installer is CommonJS
    const npm = require("../../../../npm/knowns/install.js") as {
      parseArchiveLayout: (t: string) => unknown;
    };
    const good = {
      layout: 1,
      version: "1",
      launcher: { file: "knowns.launcher", installAs: "knowns" },
      engine: { file: "knowns", installAs: "knowns-engine" },
    };
    const cases: string[] = [
      JSON.stringify(good),
      JSON.stringify({ ...good, layout: 2 }),
      JSON.stringify({ ...good, launcher: { file: "../a", installAs: "knowns" } }),
      JSON.stringify({ ...good, engine: { file: "a/b", installAs: "knowns-engine" } }),
      JSON.stringify({ ...good, engine: { file: "knowns", installAs: "..\\x" } }),
      JSON.stringify({ layout: 1 }),
      JSON.stringify(null),
      "{",
    ];
    for (const c of cases) {
      let ours: unknown;
      let theirs: unknown;
      try {
        ours = parseArchiveLayout(c);
      } catch (e) {
        ours = (e as Error).message;
      }
      try {
        theirs = npm.parseArchiveLayout(c);
      } catch (e) {
        theirs = (e as Error).message;
      }
      expect(theirs).toEqual(ours);
    }
  });

  test("npm applyArchiveLayout puts the engine back when the launcher rename fails", () => {
    // biome-ignore lint/style/noCommonJs: the npm installer is CommonJS
    const npm = require("../../../../npm/knowns/install.js") as {
      applyArchiveLayout: (d: string) => boolean;
    };
    const dir = tmp("knowns-npm-layout-");
    writeFileSync(join(dir, "knowns"), "engine");
    // layout.json names a launcher file that is not there: the second rename fails
    writeFileSync(
      join(dir, "layout.json"),
      JSON.stringify({
        layout: 1,
        launcher: { file: "missing.launcher", installAs: "knowns2" },
        engine: { file: "knowns", installAs: "knowns-engine" },
      }),
    );
    expect(() => npm.applyArchiveLayout(dir)).toThrow();
    expect(readFileSync(join(dir, "knowns"), "utf8")).toBe("engine");
    expect(existsSync(join(dir, "knowns-engine"))).toBe(false);
    expect(() => npm.applyArchiveLayout(dir)).toThrow(); // still refuses, still whole
    // a layout with a path in a name never touches anything
    writeFileSync(
      join(dir, "layout.json"),
      JSON.stringify({
        layout: 1,
        launcher: { file: "../x", installAs: "k" },
        engine: { file: "knowns", installAs: "e" },
      }),
    );
    expect(() => npm.applyArchiveLayout(dir)).toThrow("no launcher");
    expect(readFileSync(join(dir, "knowns"), "utf8")).toBe("engine");
  });
});
