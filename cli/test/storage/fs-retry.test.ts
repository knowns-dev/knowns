// KN-F5CP12: storage writes retry a transient Windows busy-file error, bounded, and only there.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWindowsFileBusy, retryWhileBusy } from "../../src/storage/core/fs-retry.ts";
import { atomicWrite } from "../../src/storage/core/util.ts";

const err = (code: string) => Object.assign(new Error(code), { code });

describe("retryWhileBusy", () => {
  test("retries EPERM/EBUSY/EACCES on win32 until the op succeeds", () => {
    for (const code of ["EPERM", "EBUSY", "EACCES"]) {
      let calls = 0;
      const slept: number[] = [];
      const out = retryWhileBusy(
        () => {
          if (++calls < 4) throw err(code);
          return "ok";
        },
        { platform: "win32", sleep: (ms) => slept.push(ms) },
      );
      expect(out).toBe("ok");
      expect(calls).toBe(4);
      expect(slept.length).toBe(3);
    }
  });

  test("gives up after the timeout and rethrows the original error", () => {
    let t = 0;
    let calls = 0;
    const e = err("EPERM");
    expect(() =>
      retryWhileBusy(
        () => {
          calls++;
          throw e;
        },
        { platform: "win32", timeoutMs: 100, delayMs: 10, now: () => t, sleep: (ms) => (t += ms) },
      ),
    ).toThrow(e);
    expect(calls).toBeGreaterThan(5);
    expect(calls).toBeLessThan(20);
  });

  test("does not retry on macOS or Linux", () => {
    for (const platform of ["darwin", "linux"]) {
      let calls = 0;
      expect(() =>
        retryWhileBusy(
          () => {
            calls++;
            throw err("EPERM");
          },
          { platform },
        ),
      ).toThrow("EPERM");
      expect(calls).toBe(1);
    }
  });

  test("does not retry other errors on win32", () => {
    let calls = 0;
    expect(() =>
      retryWhileBusy(
        () => {
          calls++;
          throw err("ENOENT");
        },
        { platform: "win32" },
      ),
    ).toThrow("ENOENT");
    expect(calls).toBe(1);
    expect(isWindowsFileBusy(err("ENOSPC"), "win32")).toBe(false);
  });
});

describe("atomicWrite", () => {
  test("still writes and replaces atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "kn-f5cp12-"));
    const p = join(dir, "a.md");
    atomicWrite(p, "one");
    atomicWrite(p, "two");
    expect(readFileSync(p, "utf8")).toBe("two");
  });
});
