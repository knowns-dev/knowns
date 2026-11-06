// TSR-CRAT15, end to end against the REAL release infrastructure: a TS build older than the npm
// `latest` runs its own `knowns update`, which reads the real registry, downloads the real release
// asset and its real <asset>.sha256 from GitHub (read-only), verifies the checksum and installs.
// Today `latest` is the Go 0.34.1, whose shasum-format checksum files must verify; once 1.x ships,
// the same test covers the package-release.ts checksum files. Tamper, missing-file and malformed
// cases run offline in test/cli/commands/update.test.ts.
//
// `update` only moves to a NEWER version (as in 0.34.1), so a rollback to 0.34.x goes through
// npm (`knowns@0.34`) or install.sh `--version`, both proven by the distribution tests.
// Opt-in with the other rollback tests (KNOWNS_ROLLBACK_034=1); a temp HOME holds everything.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { releasePlatform } from "./binaries.ts";

const enabled = process.env.KNOWNS_ROLLBACK_034 === "1" && releasePlatform("0.34.1") !== undefined;
const TEST_TIMEOUT = 600_000;
const CLI = resolve(import.meta.dir, "..", "..");
const exe = process.platform === "win32" ? "knowns.exe" : "knowns";
const target = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;

const roots: string[] = [];

describe.skipIf(!enabled)(
  "knowns update onto the real npm latest release, checksum verified",
  () => {
    let latest = "";
    let home = "";
    let bin = "";
    let env: Record<string, string> = {};

    beforeAll(async () => {
      const res = await fetch("https://registry.npmjs.org/knowns/latest");
      if (!res.ok) throw new Error(`npm registry: ${res.status}`);
      latest = ((await res.json()) as { version: string }).version;

      const root = realpathSync(mkdtempSync(join(tmpdir(), "knowns-update-real-")));
      roots.push(root);
      home = join(root, "home");
      bin = join(home, ".knowns", "bin", exe);
      mkdirSync(join(home, ".knowns", "bin"), { recursive: true });
      // A TS build that is older than any published release, installed script-managed.
      const built = Bun.spawnSync(
        [
          process.execPath,
          join(CLI, "test", "distribution", "compile-one.ts"),
          join(CLI, "src", "bin.ts"),
          target,
          bin,
          "0.0.1",
        ],
        { cwd: CLI, stdout: "pipe", stderr: "pipe" },
      );
      if (built.exitCode !== 0) throw new Error(`compile: ${built.stderr.toString()}`);
      chmodSync(bin, 0o755);
      writeFileSync(
        join(home, ".knowns", "install.json"),
        JSON.stringify({
          method: "script",
          managedBy: "knowns-script",
          updateStrategy: "self-update",
          binaryPath: bin,
        }),
      );
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
      env = { ...base, HOME: home, USERPROFILE: home, NO_COLOR: "1", KNOWNS_RUNTIME_INLINE: "1" };
      const v = Bun.spawnSync([bin, "--version"], { env, stdout: "pipe" });
      expect(v.stdout.toString().trim()).toBe("knowns version 0.0.1");
    }, TEST_TIMEOUT);

    afterAll(() => {
      for (const r of roots) rmSync(r, { recursive: true, force: true });
    });

    test(
      "the TS build verifies the real checksum and installs the real latest release",
      () => {
        const project = join(home, "project");
        mkdirSync(project, { recursive: true });
        const r = Bun.spawnSync([bin, "update"], {
          cwd: project,
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = r.stdout.toString() + r.stderr.toString();
        expect(`${r.exitCode} ${out}`).toMatch(/^0 [\s\S]*Upgrade complete\./);
        expect(out).not.toContain("checksum");
        const v = Bun.spawnSync([bin, "--version"], { env, stdout: "pipe" });
        expect(v.stdout.toString().trim()).toBe(`knowns version ${latest}`);
        const meta = JSON.parse(readFileSync(join(home, ".knowns", "install.json"), "utf8")) as {
          version: string;
        };
        expect(meta.version).toBe(latest);
      },
      TEST_TIMEOUT,
    );
  },
);
