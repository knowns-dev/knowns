// goGetwd follows os.Getwd: on unix a $PWD that names the same directory as "." wins, so a
// symlinked working directory keeps its symlinked spelling. Runs in a child process so the test
// never changes this process's cwd.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODULE = join(import.meta.dir, "..", "src", "storage", "core", "getwd.ts");
const base = realpathSync(mkdtempSync(join(tmpdir(), "knowns-getwd-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function getwdIn(cwd: string, pwd: string | undefined): string {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  if (pwd !== undefined) env.PWD = pwd;
  const res = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `import { goGetwd } from ${JSON.stringify(MODULE)}; process.stdout.write(goGetwd());`,
    ],
    { cwd, env },
  );
  return res.stdout.toString();
}

describe.skipIf(process.platform === "win32")("goGetwd", () => {
  const real = join(base, "real");
  const link = join(base, "link");
  const other = join(base, "other");
  mkdirSync(real);
  mkdirSync(other);
  symlinkSync(real, link);

  test("a PWD naming the same directory through a symlink is kept", () => {
    expect(getwdIn(link, link)).toBe(link);
  });

  test("a PWD naming another directory is ignored", () => {
    expect(getwdIn(real, other)).toBe(real);
  });

  test("a relative, missing or absent PWD falls back to the resolved cwd", () => {
    expect(getwdIn(real, "real")).toBe(real);
    expect(getwdIn(real, join(base, "nope"))).toBe(real);
    expect(getwdIn(real, undefined)).toBe(real);
  });
});
