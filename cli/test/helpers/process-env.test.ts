import { expect, test } from "bun:test";
import { withProcessEnv } from "./process-env.ts";

const KEY = "KN_PROCESS_ENV_TEST";

test("overlapping calls leave the real value behind, whichever finishes last", async () => {
  process.env[KEY] = "real";
  const slow = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await Promise.all([
    withProcessEnv({ [KEY]: "sandbox" }, () => slow(30)),
    withProcessEnv({ [KEY]: "sandbox" }, () => slow(5)),
    withProcessEnv({ [KEY]: "sandbox" }, () => slow(15)),
  ]);
  expect(process.env[KEY]).toBe("real");
  delete process.env[KEY];
  await Promise.all([
    withProcessEnv({ [KEY]: "x" }, () => slow(10)),
    withProcessEnv({ [KEY]: "x" }, () => slow(20)),
  ]);
  expect(process.env[KEY]).toBeUndefined();
});

test("a nested call restores what its caller had set", async () => {
  process.env[KEY] = "real";
  await withProcessEnv({ [KEY]: "outer" }, async () => {
    await withProcessEnv({ [KEY]: "inner" }, async () => {
      expect(process.env[KEY]).toBe("inner");
    });
    expect(process.env[KEY]).toBe("outer");
  });
  expect(process.env[KEY]).toBe("real");
  delete process.env[KEY];
});
