// AC2 of TSR-Z7CRS1 against the real registry and GitHub releases: pinning 0.34 still installs the
// Go build after 1.0.0 ships. Opt-in (KNOWNS_NETWORK_TESTS=1) because it downloads ~30 MB. Every
// install goes into a temp npm prefix / temp HOME; nothing global is touched.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { INSTALL_SH, makeSandbox, run, tempDir } from "./install-harness.ts";

const enabled = process.env.KNOWNS_NETWORK_TESTS === "1" && process.platform !== "win32";

describe.skipIf(!enabled)("AC2 (network): 0.34.x still resolves the Go build", () => {
  test("npm i knowns@0.34 installs a binary reporting 0.34.x", () => {
    const prefix = tempDir("npm-prefix");
    const cache = tempDir("npm-cache");
    const env = {
      ...(process.env as Record<string, string>),
      npm_config_prefix: prefix,
      npm_config_cache: cache,
      NO_UPDATE_CHECK: "1",
    };
    const i = run(["npm", "install", "-g", "--no-audit", "--no-fund", "knowns@0.34"], env);
    expect(i.code).toBe(0);
    const v = run([join(prefix, "bin", "knowns"), "--version"], env);
    expect(v.stdout).toMatch(/^knowns version 0\.34\.\d+\n$/);
  }, 300_000);

  test("install.sh with KNOWNS_VERSION=0.34.1 installs the Go release asset", () => {
    const sb = makeSandbox();
    const r = run(["sh", INSTALL_SH], {
      HOME: sb.home,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: tempDir("tmp"),
      KNOWNS_VERSION: "0.34.1",
      KNOWNS_NO_LINK: "1",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Version:  v0.34.1");
    const v = run([join(sb.home, ".knowns", "bin", "knowns"), "--version"], {
      HOME: sb.home,
      NO_UPDATE_CHECK: "1",
    });
    expect(v.stdout).toBe("knowns version 0.34.1\n");
  }, 300_000);
});
