import { describe, expect, test } from "bun:test";
import type { Result } from "../oracle.ts";
import { isReadOnlyStep, retryLostCapture, type Step } from "./search-harness.ts";

const empty: Result = { code: 0, stdout: "", stderr: "" };
const out = (s: string): Result => ({ code: 0, stdout: s, stderr: "" });
const get: Step = { args: ["config", "get", "x", "--plain"] };

describe("retryLostCapture", () => {
  test("a read-only step with an empty Go capture and TS output is taken again, once", () => {
    let calls = 0;
    const r = retryLostCapture(get, empty, out("\n"), () => {
      calls++;
      return out("\n");
    });
    expect(calls).toBe(1);
    expect(r).toEqual({ result: out("\n"), retried: true });
  });

  test("a second capture that is still empty is returned as it is (and flagged)", () => {
    const r = retryLostCapture(get, empty, out("x\n"), () => empty);
    expect(r).toEqual({ result: empty, retried: true });
  });

  test("write steps are never run twice", () => {
    for (const args of [
      ["config", "set", "a", "b"],
      ["task", "create", "t"],
      ["doc", "edit", "d"],
    ]) {
      let calls = 0;
      const r = retryLostCapture({ args }, empty, out("done\n"), () => {
        calls++;
        return out("done\n");
      });
      expect(calls).toBe(0);
      expect(r.retried).toBe(false);
    }
    expect(isReadOnlyStep({ args: ["config", "get", "k"], stdin: "" })).toBe(false);
  });

  test("a real diff is left alone: Go printed something, or both are empty, or Go failed", () => {
    const never = () => {
      throw new Error("rerun");
    };
    expect(retryLostCapture(get, out("a\n"), out("b\n"), never).retried).toBe(false);
    expect(retryLostCapture(get, empty, empty, never).retried).toBe(false);
    expect(
      retryLostCapture(get, { code: 1, stdout: "", stderr: "" }, out("x"), never).retried,
    ).toBe(false);
  });
});
