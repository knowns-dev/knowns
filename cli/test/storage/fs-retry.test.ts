// KN-F5CP12: storage writes retry a transient Windows busy-file error, bounded, and only there.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DENIAL_MAX_TRIES,
  isWindowsFileBusy,
  readUtf8Retrying,
  retryWhileBusy,
  withRetryBudget,
} from "../../src/storage/core/fs-retry.ts";
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
        { platform: "win32", isWritable: () => true, sleep: (ms) => slept.push(ms) },
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
        {
          platform: "win32",
          isWritable: () => true,
          timeoutMs: 100,
          delayMs: 10,
          now: () => t,
          sleep: (ms) => (t += ms),
        },
      ),
    ).toThrow(e);
    expect(calls).toBeGreaterThan(3);
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

describe("backoff, bounds and denials (review of KN-F5CP12)", () => {
  test("the delay doubles from 1 ms to a 50 ms cap", () => {
    let t = 0;
    const slept: number[] = [];
    expect(() =>
      retryWhileBusy(
        () => {
          throw err("EBUSY");
        },
        {
          platform: "win32",
          timeoutMs: 400,
          now: () => t,
          sleep: (ms) => {
            slept.push(ms);
            t += ms;
          },
        },
      ),
    ).toThrow("EBUSY");
    expect(slept.slice(0, 8)).toEqual([1, 2, 4, 8, 16, 32, 50, 50]);
  });

  test("with the real clock a 50 ms budget gives up in well under a second", () => {
    const e = err("EBUSY");
    const started = Date.now();
    expect(() =>
      retryWhileBusy(
        () => {
          throw e;
        },
        { platform: "win32", timeoutMs: 50 },
      ),
    ).toThrow(e);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(45);
    expect(took).toBeLessThan(400);
  });

  test("a denial on a target that is not a writable file fails fast with the original error", () => {
    let calls = 0;
    const e = err("EPERM");
    expect(() =>
      retryWhileBusy(
        () => {
          calls++;
          throw e;
        },
        { platform: "win32", isWritable: () => false, sleep: () => undefined },
      ),
    ).toThrow(e);
    expect(calls).toBe(DENIAL_MAX_TRIES);
    // EBUSY is never a denial: it keeps the whole budget.
    let t = 0;
    let busy = 0;
    expect(() =>
      retryWhileBusy(
        () => {
          busy++;
          throw err("EBUSY");
        },
        {
          platform: "win32",
          isWritable: () => false,
          timeoutMs: 300,
          now: () => t,
          sleep: (ms) => (t += ms),
        },
      ),
    ).toThrow("EBUSY");
    expect(busy).toBeGreaterThan(DENIAL_MAX_TRIES);
  });

  test("a shared budget bounds a listing with several locked files", () => {
    let t = 0;
    let calls = 0;
    const op = () => {
      calls++;
      throw err("EBUSY");
    };
    const opts = {
      platform: "win32",
      timeoutMs: 250,
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
      },
    };
    withRetryBudget(
      100,
      () => {
        for (let i = 0; i < 10; i++) expect(() => retryWhileBusy(op, opts)).toThrow("EBUSY");
      },
      () => t,
    );
    // Ten files, one 100 ms budget: the first spends it, the other nine fail on their first try.
    expect(t).toBeLessThan(160);
    expect(calls).toBeLessThan(10 + 12);
  });

  test("a listed file that reads as missing gets one more try, on win32 only", () => {
    let calls = 0;
    const flaky = () => {
      if (++calls === 1) throw err("ENOENT");
      return "ok";
    };
    expect(
      retryWhileBusy(flaky, { platform: "win32", retryMissing: true, sleep: () => undefined }),
    ).toBe("ok");
    calls = 0;
    expect(() => retryWhileBusy(flaky, { platform: "linux", retryMissing: true })).toThrow(
      "ENOENT",
    );
    calls = 0;
    expect(() => retryWhileBusy(flaky, { platform: "win32" })).toThrow("ENOENT");
  });

  test("a missing file still reports ENOENT and a real read works", () => {
    const dir = mkdtempSync(join(tmpdir(), "kn-f5cp12-"));
    expect(() => readUtf8Retrying(join(dir, "nope.md"), { listed: true })).toThrow("ENOENT");
    const p = join(dir, "a.md");
    atomicWrite(p, "x");
    expect(readUtf8Retrying(p, { listed: true })).toBe("x");
  });
});
