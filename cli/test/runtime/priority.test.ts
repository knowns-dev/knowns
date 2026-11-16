// Review of perf/runtime-idle: background priority must not reach processes that answer
// interactive requests.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lowerProcessPriority, restoreNormalPriority } from "../../src/runtime/priority.ts";

test("lowerProcessPriority lowers, and the environment switch turns it off", () => {
  const calls: Array<[number, number]> = [];
  expect(lowerProcessPriority({}, (pid, p) => calls.push([pid, p]))).toBe(true);
  expect(calls).toEqual([[0, 10]]);
  expect(
    lowerProcessPriority({ KNOWNS_RUNTIME_NORMAL_PRIORITY: "1" }, () => calls.push([9, 9])),
  ).toBe(false);
  expect(calls).toHaveLength(1);
});

test("restoreNormalPriority sets the child to normal and never throws", () => {
  const calls: Array<[number, number]> = [];
  expect(restoreNormalPriority(4242, (pid, p) => calls.push([pid, p]))).toBe(true);
  expect(calls).toEqual([[4242, 0]]);
  expect(
    restoreNormalPriority(1, () => {
      throw new Error("EACCES");
    }),
  ).toBe(false);
});

test("the LSP daemon does not lower its priority; the runtime daemon does", () => {
  const src = join(import.meta.dir, "..", "..", "src", "cli", "commands");
  expect(readFileSync(join(src, "lsp-daemon.ts"), "utf8")).not.toContain("lowerProcessPriority");
  expect(readFileSync(join(src, "runtime-daemon.ts"), "utf8")).toContain("lowerProcessPriority");
});
