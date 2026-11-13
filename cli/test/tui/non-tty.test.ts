// The interactive commands without a terminal. On unix, Go's huh opens /dev/tty and fails with a
// fixed message when there is none; the TS prompts report the same text (compared against Go in
// init.test.ts and setup.test.ts). On Windows there is no /dev/tty: Go's wizard waits on the console,
// so the contract proven here is the one that matters for a script, a pipe or CI: the TS commands
// give up with an error instead of hanging, and write nothing.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "..", "src", "main.ts");

function runNoTty(args: string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "knowns-nontty-")));
  const home = join(root, "home");
  const dir = join(root, "proj");
  mkdirSync(home);
  mkdirSync(dir);
  const r = Bun.spawnSync([process.execPath, MAIN, ...args], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      NO_UPDATE_CHECK: "1",
      KNOWNS_RUNTIME_INLINE: "1",
      KNOWN_LSP_AUTO_INSTALL: "0",
      SystemRoot: process.env.SystemRoot ?? "",
    },
    stdin: Buffer.from(""),
    timeout: 60_000,
  });
  return { dir, home, code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("interactive commands without a terminal do not hang", () => {
  test("init with no name and no --no-wizard", () => {
    const r = runNoTty(["init"]);
    expect(r.code).not.toBeNull();
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/^Error: /m);
    expect(existsSync(join(r.dir, ".knowns"))).toBe(false);
  }, 90_000);

  test("settings", () => {
    const r = runNoTty(["settings", "--global"]);
    expect(r.code).not.toBeNull();
    expect(existsSync(join(r.home, ".knowns", "settings.json"))).toBe(false);
  }, 90_000);

  test("setup --global without a target", () => {
    const r = runNoTty(["setup", "--global"]);
    expect(r.code).not.toBeNull();
    expect(r.code).not.toBe(0);
    expect(existsSync(join(r.home, ".claude.json"))).toBe(false);
  }, 90_000);
});
