// Approved divergence (D12, TSR-2P6ZDV): `knowns update` on Windows moves knowns.exe aside before
// renaming the new binary into place. When that final rename failed, 0.34.1 left no knowns.exe at
// all (and a stray temp file). The TS build puts the previous binary back and removes the temp.
// The Windows path is driven on every OS with a rename that fails only for the final step.
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceBinary } from "../../../src/cli/commands/update.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(): { dir: string; src: string; dest: string } {
  const dir = mkdtempSync(join(tmpdir(), "knowns-update-rb-"));
  dirs.push(dir);
  const src = join(dir, "new-knowns.exe");
  const dest = join(dir, "bin", "knowns.exe");
  writeFileSync(src, "NEW");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(dest, "OLD");
  return { dir, src, dest };
}

describe("update binary replacement on Windows", () => {
  test("a failed final rename restores the previous binary and removes the temp file", () => {
    const { src, dest } = setup();
    const failingFinal = (from: string, to: string) => {
      if (from === `${dest}.tmp` && to === dest) throw new Error("EPERM: file in use");
      renameSync(from, to);
    };
    expect(() => replaceBinary(src, dest, "windows", failingFinal)).toThrow("EPERM: file in use");
    expect(readFileSync(dest, "utf8")).toBe("OLD");
    expect(existsSync(`${dest}.tmp`)).toBe(false);
  });

  test("a successful replacement installs the new binary and keeps .old", () => {
    const { src, dest } = setup();
    replaceBinary(src, dest, "windows");
    expect(readFileSync(dest, "utf8")).toBe("NEW");
    expect(readFileSync(`${dest}.old`, "utf8")).toBe("OLD");
    expect(existsSync(`${dest}.tmp`)).toBe(false);
  });
});
