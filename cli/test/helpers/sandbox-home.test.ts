// The sandbox-home preload: the test process runs with a temp HOME, and its leak detector finds
// temp-dir paths in a registry file. Only temp files are used; the real registry is never written.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalRootPath } from "../../src/storage/core/global-root.ts";
import { tempPathsIn } from "./sandbox-home.ts";

describe("sandbox home preload", () => {
  test("HOME and USERPROFILE point at a temp dir, not the real home", () => {
    const real = process.env.KNOWNS_TEST_REAL_HOME as string;
    expect(real).toBeTruthy();
    const tmp = realpathSync(tmpdir());
    for (const k of ["HOME", "USERPROFILE"]) {
      const v = process.env[k] as string;
      expect(v).not.toBe(real);
      expect(realpathSync(v).startsWith(tmp)).toBe(true);
    }
    expect(globalRootPath().startsWith(process.env.HOME as string)).toBe(true);
  });

  test("tempPathsIn finds temp project paths with either separator and ignores others", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "knowns-guard-")));
    const file = join(dir, "projects.json");
    const posix = join(dir, "knowns-cmd-abc", "proj", ".knowns");
    const windows = posix.replaceAll("/", "\\");
    writeFileSync(
      file,
      JSON.stringify({
        projects: [
          { root: posix },
          { root: windows },
          { root: "/Users/someone/work/app/.knowns" },
          { root: "C:\\Users\\someone\\work\\app\\.knowns" },
        ],
      }),
    );
    const found = tempPathsIn(file);
    expect(found.size).toBe(1);
    expect([...found][0]).toBe(posix.replaceAll("\\", "/").toLowerCase());
    expect(tempPathsIn(join(dir, "missing.json")).size).toBe(0);
  });
});
