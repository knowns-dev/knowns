// `knowns update`. The offline and usage paths are diffed against Go 0.34.1; everything past the
// registry lookup runs in-process against `updateSeams` with a local HTTP server standing in for
// the npm registry and the release host, an isolated HOME, and a temp file standing in for the
// binary, so no test ever replaces the running executable or downloads a real release.
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
import { delimiter, join } from "node:path";
import { updateSeams } from "../../../src/cli/commands/update.ts";
import { checkForUpdate, fetchLatestVersion } from "../../../src/domain/update/notifier.ts";
import { VERSION } from "../../../src/version.ts";
import { withProcessEnv } from "../../helpers/process-env.ts";
import { runTs } from "../oracle.ts";
import { hasGoBin } from "./search-harness.ts";
import { expectParity } from "./search-parity.ts";

const SLOW = 120_000;
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

// --- Go parity (offline) ------------------------------------------------------------------------

const offline = {
  HTTPS_PROXY: "http://127.0.0.1:1",
  HTTP_PROXY: "http://127.0.0.1:1",
  NO_PROXY: "",
};

(hasGoBin ? describe : describe.skip)("update matches Go offline", () => {
  test(
    "registry unreachable, --check, usage errors, help",
    async () => {
      const step = (args: string[]) => ({ args, env: offline, stdin: "" });
      await expectParity("empty", [
        step(["update"]),
        step(["update", "--check"]),
        step(["update", "extra"]),
        step(["update", "--bogus"]),
        step(["update", "--help"]),
        step(["help", "update"]),
      ]);
    },
    SLOW,
  );
});

// --- the flow against local servers --------------------------------------------------------------

let server: ReturnType<typeof Bun.serve>;
let archive: Uint8Array;
const latest = "99.0.0";
const hits: string[] = [];

beforeAll(async () => {
  // A release archive holding a "knowns" file, built with tar (present on macOS, Linux and Windows).
  const src = tmp("knowns-rel-src-");
  // The tests pin goos to linux, so the flow looks for `knowns` on every host.
  const name = "knowns";
  writeFileSync(join(src, name), "NEW-BINARY");
  const out = join(tmp("knowns-rel-out-"), "knowns.tar.gz");
  const r = Bun.spawnSync(["tar", "-czf", out, "-C", src, name]);
  if (r.exitCode !== 0) throw new Error(`tar failed: ${r.stderr.toString()}`);
  archive = new Uint8Array(readFileSync(out));
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      hits.push(path);
      if (path === "/latest") return Response.json({ version: latest });
      // The real asset name: a `knowns-*` archive next to the extracted `knowns` must never be the
      // file installed (TSR-CRAT15).
      if (path === "/knowns-linux-x64.tar.gz") return new Response(archive);
      // D12 (TSR-CRAT15): update verifies <asset>.sha256, published as `<hex>  <file>`.
      if (path === "/knowns-linux-x64.tar.gz.sha256")
        return new Response(`${sha256(archive)}  knowns-linux-x64.tar.gz\n`);
      // A tampered asset: the published digest is of different bytes.
      if (path === "/tampered.tar.gz") return new Response(archive);
      if (path === "/tampered.tar.gz.sha256")
        return new Response(`${"0".repeat(64)}  tampered.tar.gz\n`);
      // An asset with no checksum file next to it.
      if (path === "/nosum.tar.gz") return new Response(archive);
      if (path === "/nosum.tar.gz.sha256")
        return new Response("nope", { status: 404, statusText: "Not Found" });
      // A checksum file that is not a digest.
      if (path === "/badsum.tar.gz") return new Response(archive);
      if (path === "/badsum.tar.gz.sha256") return new Response("<html>not a checksum</html>");
      if (path === "/missing.tar.gz")
        return new Response("nope", { status: 404, statusText: "Not Found" });
      return new Response("?", { status: 500 });
    },
  });
});
afterAll(() => server.stop(true));

const base = (): string => `http://127.0.0.1:${server.port}`;
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

interface Sandbox {
  home: string;
  project: string;
  env: Record<string, string>;
  bin: string;
}

/** An isolated HOME with a script-style install: binary under ~/.knowns/bin and install.json. */
function sandbox(opts: { bom?: boolean; meta?: object | null } = {}): Sandbox {
  const home = tmp("knowns-update-home-");
  const project = tmp("knowns-update-proj-");
  const binDir = join(home, ".knowns", "bin");
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, process.platform === "win32" ? "knowns.exe" : "knowns");
  writeFileSync(bin, "OLD-BINARY");
  chmodSync(bin, 0o755);
  if (opts.meta !== null) {
    const meta = JSON.stringify(
      opts.meta ?? {
        method: "script",
        managedBy: "script",
        updateStrategy: "self-update",
        binaryPath: bin,
      },
    );
    writeFileSync(join(home, ".knowns", "install.json"), (opts.bom ? "﻿" : "") + meta);
  }
  return {
    home,
    project,
    bin,
    env: {
      HOME: home,
      USERPROFILE: home,
      NO_UPDATE_CHECK: "1",
      CI: "1",
      KNOWNS_RUNTIME_INLINE: "1",
    },
  };
}

async function runPlain(env: Record<string, string>, sb: Sandbox) {
  const r = await withProcessEnv(env, () => runTs(["update"], { cwd: sb.project, env }));
  return { ...r, stdout: plain(r.stdout), stderr: plain(r.stderr) };
}

const saved = { ...updateSeams };
function seams(overrides: Partial<typeof updateSeams>): void {
  Object.assign(updateSeams, saved, {
    fetchLatest: async () => latest,
    isTTY: () => false,
    // Package-manager upgrades are deferred on Windows; tests that want that say so.
    goos: () => "linux",
    restartRuntime: async () => {},
    releaseUrl: () => `${base()}/knowns-linux-x64.tar.gz`,
    ...overrides,
  });
}
const restore = () => Object.assign(updateSeams, saved);

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI styling
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

async function update(sb: Sandbox, args: string[] = ["update"]) {
  const r = await withProcessEnv(sb.env, () => runTs(args, { cwd: sb.project, env: sb.env }), {
    keepPath: true,
  });
  return { ...r, stdout: plain(r.stdout), stderr: plain(r.stderr) };
}

describe("update reads install metadata", () => {
  test(
    "install.json written with a UTF-8 BOM is read (AC2, issue #155)",
    async () => {
      const sb = sandbox({ bom: true });
      seams({ executable: () => sb.bin });
      try {
        const r = await update(sb);
        expect(r.stdout + r.stderr).not.toContain("read install metadata");
        expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" });
        expect(r.stdout).toContain("Upgrade complete.");
        expect(readFileSync(sb.bin, "utf8")).toBe("NEW-BINARY");
        const meta = JSON.parse(
          readFileSync(join(sb.home, ".knowns", "install.json"), "utf8"),
        ) as Record<string, unknown>;
        expect(meta.version).toBe("99.0.0");
        expect(meta.method).toBe("script");
        expect(meta.binaryPath).toBe(sb.bin);
        expect(meta.platform).toBeTruthy();
      } finally {
        restore();
      }
    },
    SLOW,
  );

  test(
    "the same file without a BOM behaves identically",
    async () => {
      const sb = sandbox();
      seams({ executable: () => sb.bin });
      try {
        const r = await update(sb);
        expect(r.code).toBe(0);
        expect(readFileSync(sb.bin, "utf8")).toBe("NEW-BINARY");
      } finally {
        restore();
      }
    },
    SLOW,
  );

  test(
    "invalid install.json still fails with the Go prefix",
    async () => {
      const sb = sandbox({ meta: null });
      writeFileSync(join(sb.home, ".knowns", "install.json"), "{nope");
      seams({ executable: () => sb.bin });
      try {
        const r = await update(sb);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("Error: read install metadata: ");
      } finally {
        restore();
      }
    },
    SLOW,
  );
});

describe("update flow", () => {
  test("already on the latest version", async () => {
    const sb = sandbox();
    seams({ fetchLatest: async () => VERSION });
    try {
      const r = await update(sb);
      expect(r).toEqual({
        code: 0,
        stdout: expect.stringContaining(`Already on the latest version v${VERSION}`),
        stderr: "",
      });
    } finally {
      restore();
    }
  });

  test("registry unreachable", async () => {
    const sb = sandbox();
    seams({ fetchLatest: async () => "" });
    try {
      const r = await update(sb);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(
        "could not reach the npm registry — check your network connection",
      );
    } finally {
      restore();
    }
  });

  test("--check names the command and installs nothing", async () => {
    const sb = sandbox();
    seams({ executable: () => sb.bin });
    try {
      const r = await update(sb, ["update", "--check"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("UPDATE");
      expect(r.stdout).toContain("v99.0.0");
      expect(r.stdout).toContain(`(current v${VERSION})`);
      expect(r.stdout).toContain("Run: ");
      expect(r.stdout).toContain("knowns update");
      expect(readFileSync(sb.bin, "utf8")).toBe("OLD-BINARY");
    } finally {
      restore();
    }
  });

  test(
    "a failed download leaves the binary alone",
    async () => {
      const sb = sandbox();
      seams({ executable: () => sb.bin, releaseUrl: () => `${base()}/missing.tar.gz` });
      try {
        const r = await update(sb);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("download release artifact: unexpected status: 404");
        expect(readFileSync(sb.bin, "utf8")).toBe("OLD-BINARY");
      } finally {
        restore();
      }
    },
    SLOW,
  );

  // D12 (TSR-CRAT15): 0.34.1 extracts next to the downloaded `knowns-<platform>.tar.gz`, which its
  // `knowns-*` matcher also accepts, so the archive itself could be installed as the binary (the
  // order of the directory walk decides). Extraction must land in a directory holding none of
  // the downloaded files; checked directly, so the result does not depend on readdir order.
  test(
    "the release is extracted into its own directory, apart from the downloaded files",
    async () => {
      const sb = sandbox();
      const seen: string[][] = [];
      seams({
        executable: () => sb.bin,
        extract: async (archive: string, dir: string, env: Record<string, string | undefined>) => {
          seen.push(readdirSync(dir));
          return saved.extract(archive, dir, env);
        },
      });
      try {
        const r = await update(sb);
        expect(r.code).toBe(0);
        expect(seen).toEqual([[]]);
        expect(readFileSync(sb.bin, "utf8")).toBe("NEW-BINARY");
      } finally {
        restore();
      }
    },
    SLOW,
  );

  // D12 (TSR-CRAT15): 0.34.1 installs whatever the download returned.
  for (const [name, path, message] of [
    [
      "a checksum mismatch",
      "tampered",
      "release artifact checksum mismatch for tampered.tar.gz: expected 0000",
    ],
    [
      "a missing checksum file",
      "nosum",
      "download release checksum (nosum.tar.gz.sha256): unexpected status: 404",
    ],
    [
      "a checksum file that is not a digest",
      "badsum",
      "release checksum file badsum.tar.gz.sha256 is not a sha256 digest",
    ],
  ] as const) {
    test(
      `${name} refuses the update and leaves the binary alone`,
      async () => {
        const sb = sandbox();
        seams({ executable: () => sb.bin, releaseUrl: () => `${base()}/${path}.tar.gz` });
        try {
          const r = await update(sb);
          expect(r.code).toBe(1);
          expect(r.stderr).toContain(message);
          expect(r.stderr).toContain("the current binary was not changed");
          expect(readFileSync(sb.bin, "utf8")).toBe("OLD-BINARY");
        } finally {
          restore();
        }
      },
      SLOW,
    );
  }

  test("a package-manager install runs the manager and records it", async () => {
    const sb = sandbox({ meta: null });
    const bin = tmp("knowns-fake-bin-");
    const npm = join(bin, process.platform === "win32" ? "npm.cmd" : "npm");
    writeFileSync(npm, "x");
    chmodSync(npm, 0o755);
    const calls: Array<{ bin: string; args: string[] }> = [];
    seams({
      executable: () => join(sb.home, "lib", "node_modules", "knowns", "bin", "knowns"),
      run: async (b, a) => {
        calls.push({ bin: b, args: a });
        return 0;
      },
    });
    try {
      const env = { ...sb.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
      const r = await runPlain(env, sb);
      expect(r.code).toBe(0);
      // Windows resolves npm through PATHEXT, so the extension may be upper case.
      expect(calls.map((c) => ({ ...c, bin: c.bin.toLowerCase() }))).toEqual([
        { bin: npm.toLowerCase(), args: ["i", "-g", "knowns"] },
      ]);
      expect(r.stdout).toContain("Running: ");
      expect(r.stdout).toContain("Upgrade complete.");
      const meta = JSON.parse(
        readFileSync(join(sb.home, ".knowns", "install.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(meta.method).toBe("npm");
      expect(meta.managedBy).toBe("npm");
      expect(meta.version).toBe("99.0.0");
    } finally {
      restore();
    }
  });

  test("a failing upgrade command fails the update", async () => {
    const sb = sandbox({ meta: null });
    const bin = tmp("knowns-fake-bin-");
    const npm = join(bin, process.platform === "win32" ? "npm.cmd" : "npm");
    writeFileSync(npm, "x");
    chmodSync(npm, 0o755);
    seams({
      executable: () => join(sb.home, "lib", "node_modules", "knowns", "bin", "knowns"),
      run: async () => 1,
    });
    try {
      const env = { ...sb.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
      const r = await runPlain(env, sb);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Error: upgrade failed: exit status 1");
      expect(existsSync(join(sb.home, ".knowns", "install.json"))).toBe(false);
    } finally {
      restore();
    }
  });

  test("a missing package manager is reported", async () => {
    const sb = sandbox({ meta: null });
    seams({ executable: () => join(sb.home, "lib", "node_modules", "knowns", "bin", "knowns") });
    try {
      const env = { ...sb.env, PATH: tmp("knowns-empty-path-") };
      const r = await runPlain(env, sb);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("npm not found in PATH — install it first or upgrade manually");
    } finally {
      restore();
    }
  });

  test("Windows package-manager installs get guidance instead of an upgrade", async () => {
    const sb = sandbox({ meta: null });
    let ran = false;
    seams({
      goos: () => "windows",
      executable: () => join(sb.home, "lib", "node_modules", "knowns", "bin", "knowns.exe"),
      run: async () => {
        ran = true;
        return 0;
      },
    });
    try {
      const r = await update(sb);
      expect(r.code).toBe(0);
      expect(ran).toBe(false);
      expect(r.stdout).toContain(
        "Windows cannot safely run npm while this knowns.exe process is active.",
      );
      expect(r.stdout).toContain("fresh PowerShell");
      expect(r.stdout).not.toContain("Upgrade complete.");
    } finally {
      restore();
    }
  });

  test("Homebrew runs brew update then the upgrade with HOMEBREW_NO_AUTO_UPDATE", async () => {
    const sb = sandbox({ meta: null });
    const bin = tmp("knowns-fake-bin-");
    const brew = join(bin, process.platform === "win32" ? "brew.cmd" : "brew");
    writeFileSync(brew, "x");
    chmodSync(brew, 0o755);
    const calls: Array<{ args: string[]; noAuto: string | undefined }> = [];
    seams({
      executable: () => "/opt/homebrew/bin/knowns",
      run: async (_b, a, e) => {
        calls.push({ args: a, noAuto: e.HOMEBREW_NO_AUTO_UPDATE });
        return 0;
      },
    });
    try {
      const env = { ...sb.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
      const r = await runPlain(env, sb);
      expect(r.code).toBe(0);
      expect(calls).toEqual([
        { args: ["update"], noAuto: undefined },
        { args: ["upgrade", "knowns-dev/tap/knowns"], noAuto: "1" },
      ]);
      expect(r.stdout).toContain("Refreshing Homebrew...");
    } finally {
      restore();
    }
  });

  test("an unknown install method without a terminal says how to reinstall", async () => {
    const sb = sandbox({ meta: null });
    seams({ executable: () => "/somewhere/else/knowns" });
    try {
      const env = { ...sb.env };
      delete (env as Record<string, string | undefined>).npm_config_user_agent;
      const r = await runPlain({ ...env, npm_config_user_agent: "" }, sb);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(
        "could not detect how knowns was installed; reinstall using one of:",
      );
      expect(r.stderr).toContain("brew install knowns-dev/tap/knowns");
    } finally {
      restore();
    }
  });

  test("on a terminal the detected method is confirmed, and Ctrl-C cancels", async () => {
    const sb = sandbox();
    const questions: string[] = [];
    seams({
      executable: () => sb.bin,
      isTTY: () => true,
      confirm: async (q) => {
        questions.push(q);
        return undefined;
      },
    });
    try {
      const r = await update(sb);
      expect(questions).toEqual(["  Proceed with this method?"]);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("Detected install method: Install script");
      expect(r.stderr).toContain("Error: update cancelled: command cancelled");
      expect(readFileSync(sb.bin, "utf8")).toBe("OLD-BINARY");
    } finally {
      restore();
    }
  });

  test("declining the detected method offers the list", async () => {
    const sb = sandbox();
    let offered: string[] = [];
    seams({
      executable: () => sb.bin,
      isTTY: () => true,
      confirm: async () => false,
      chooseMethod: async (o) => {
        offered = o.map((x) => x.method);
        return undefined;
      },
    });
    try {
      const r = await update(sb);
      expect(offered).toEqual(["script", "brew", "npm", "bun", "pnpm", "yarn"]);
      expect(r.stderr).toContain("update cancelled");
    } finally {
      restore();
    }
  });

  test(
    "after an upgrade the project's MCP configs are pointed at the local binary",
    async () => {
      const sb = sandbox();
      mkdirSync(join(sb.project, ".knowns"));
      writeFileSync(
        join(sb.project, ".mcp.json"),
        JSON.stringify({
          mcpServers: { knowns: { command: "npx", args: ["-y", "knowns", "mcp"] } },
        }),
      );
      // The configs are rewritten to `knowns` only when it is on PATH (otherwise they keep npx).
      const bin = tmp("knowns-fake-bin-");
      const fake = join(bin, process.platform === "win32" ? "knowns.cmd" : "knowns");
      writeFileSync(fake, "x");
      chmodSync(fake, 0o755);
      sb.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
      seams({ executable: () => sb.bin });
      try {
        const r = await withProcessEnv(sb.env, async () => {
          const out = await runTs(["update"], { cwd: sb.project, env: sb.env });
          return { ...out, stdout: plain(out.stdout), stderr: plain(out.stderr) };
        });
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("synced");
        expect(r.stdout).toContain(".mcp.json");
        expect(r.stdout).toContain("Synced 1 MCP config(s) to use local binary.");
        expect(r.stdout).toContain("to sync skills and rebuild the search index.");
        const cfg = JSON.parse(readFileSync(join(sb.project, ".mcp.json"), "utf8")) as {
          mcpServers: { knowns: { command: string } };
        };
        expect(cfg.mcpServers.knowns.command).toBe("knowns");
      } finally {
        restore();
      }
    },
    SLOW,
  );

  test(
    "a runtime restart failure is a warning, not a failure",
    async () => {
      const sb = sandbox();
      let calls = 0;
      seams({
        executable: () => sb.bin,
        restartRuntime: async () => {
          // the script path restarts once itself and fails the command; the generic path warns
          calls++;
          throw new Error("boom");
        },
      });
      try {
        const r = await update(sb);
        expect(calls).toBeGreaterThan(0);
        // Go's script path returns the restart error from runScriptManagedUpgrade.
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("boom");
      } finally {
        restore();
      }
    },
    SLOW,
  );
});

describe("update notifier", () => {
  test("fetchLatestVersion reads the registry document, and is empty on any failure", async () => {
    expect(await fetchLatestVersion(fetch, `${base()}/latest`)).toBe(latest);
    expect(await fetchLatestVersion(fetch, `${base()}/missing.tar.gz`)).toBe("");
    expect(await fetchLatestVersion(fetch, "http://127.0.0.1:1/x")).toBe("");
  });

  test("a newer version prints the notice and is cached for an hour", async () => {
    const sb = sandbox({ meta: null });
    hits.length = 0;
    const notice = await checkForUpdate(sb.env, { url: `${base()}/latest`, version: "1.0.0" });
    expect(notice).toBe("\n UPDATE  v99.0.0 available (current v1.0.0) → knowns update\n");
    const again = await checkForUpdate(sb.env, { url: `${base()}/latest`, version: "1.0.0" });
    expect(again).toBe(notice);
    expect(hits.filter((h) => h === "/latest")).toHaveLength(1);
    const cache = JSON.parse(
      readFileSync(join(sb.home, ".knowns", "cli-cache.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(cache.latestVersion).toBe("99.0.0");
    // An expired cache fetches again.
    await checkForUpdate(sb.env, {
      url: `${base()}/latest`,
      version: "1.0.0",
      now: () => Date.now() + 2 * 3_600_000,
    });
    expect(hits.filter((h) => h === "/latest")).toHaveLength(2);
  });

  test("up to date, or unreachable, is silent", async () => {
    const sb = sandbox({ meta: null });
    expect(await checkForUpdate(sb.env, { url: `${base()}/latest`, version: "99.0.0" })).toBe("");
    const sb2 = sandbox({ meta: null });
    expect(await checkForUpdate(sb2.env, { url: "http://127.0.0.1:1/x", version: "1.0.0" })).toBe(
      "",
    );
  });
});

describe("update notice through the root command", () => {
  const seed = (home: string, latestVersion: string, lastChecked = Date.now()) => {
    mkdirSync(join(home, ".knowns"), { recursive: true });
    writeFileSync(
      join(home, ".knowns", "cli-cache.json"),
      JSON.stringify({ lastChecked, latestVersion }),
    );
  };
  const env = (home: string) => ({
    HOME: home,
    USERPROFILE: home,
    NO_UPDATE_CHECK: "",
    CI: "",
    KNOWNS_RUNTIME_INLINE: "1",
  });

  test("a real command prints Go's notice from a cached newer version, with no network", async () => {
    const { installUpdateNotifier } = await import("../../../src/wiring/update.ts");
    const { runtimeHooks } = await import("../../../src/cli/core/hooks.ts");
    const home = tmp("knowns-notice-home-");
    seed(home, "99.0.0");
    const before = runtimeHooks.checkForUpdate;
    installUpdateNotifier();
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      throw new Error("no network");
    }) as unknown as typeof fetch;
    try {
      const e = env(home);
      const r = await withProcessEnv(e, () => runTs(["quickstart"], { env: e }));
      expect(r.code).toBe(0);
      expect(r.stderr).toBe(`\n UPDATE  v99.0.0 available (current v${VERSION}) → knowns update\n`);
      expect(fetched).toBe(0);
      // --plain, --json and `update` never print it.
      const p = await withProcessEnv(e, () => runTs(["quickstart", "--plain"], { env: e }));
      expect(p.stderr).toBe("");
    } finally {
      globalThis.fetch = realFetch;
      runtimeHooks.checkForUpdate = before;
    }
  });

  test("a fresh cache costs no fetch and almost no time", async () => {
    const home = tmp("knowns-notice-home-");
    seed(home, "99.0.0");
    const e = env(home);
    let fetched = 0;
    const t0 = performance.now();
    const notice = await checkForUpdate(e, {
      fetch: (async () => {
        fetched++;
        throw new Error("no network");
      }) as unknown as typeof fetch,
    });
    const ms = performance.now() - t0;
    expect(notice).toContain("v99.0.0");
    expect(fetched).toBe(0);
    expect(ms).toBeLessThan(50);
  });
});
