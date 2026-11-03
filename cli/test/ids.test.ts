// AC-2: ID generation matches internal/models/id.go (ported from id_test.go).
import { describe, expect, test } from "bun:test";
import {
  BASE36_MAX,
  DEFAULT_TASK_ID_PATTERN,
  deriveTaskIdPrefix,
  encodeBase,
  newPrefixedTaskId,
  newTaskId,
  normalizeTaskIdPrefix,
  PREFIXED_TASK_ID_PATTERN,
  randomBelow,
  sanitizeTitle,
  taskFileName,
} from "../src/models/id.ts";
import { idFromFilename, taskFileMatches } from "../src/storage/core/util.ts";
import { fixtureFiles, manifest } from "./helpers/fixtures.ts";

describe("normalizeTaskIdPrefix", () => {
  test.each([
    ["", ""],
    [" kn ", "KN"],
    ["is2", "IS2"],
    ["Feature8", "FEATURE8"],
  ])("%p -> %p", (input, want) => {
    expect(normalizeTaskIdPrefix(input)).toBe(want);
  });

  test.each(["A", "1A", "TOO-LONG", "ABCDEFGHI", "A_", "A B"])("rejects %p", (input) => {
    expect(() => normalizeTaskIdPrefix(input)).toThrow(
      "task ID prefix must be 2-8 alphanumeric characters and start with a letter",
    );
  });
});

describe("generated IDs", () => {
  test("prefixed IDs are PREFIX plus six Crockford Base32 characters", () => {
    for (let i = 0; i < 500; i++) {
      expect(newPrefixedTaskId("kn")).toMatch(/^KN-[0-9A-HJKMNP-TV-Z]{6}$/);
    }
  });

  test("prefixed IDs require a legal prefix", () => {
    expect(() => newPrefixedTaskId("")).toThrow("task ID prefix is required");
    expect(() => newPrefixedTaskId("1bad")).toThrow();
  });

  test("default IDs are six lowercase base-36 characters", () => {
    for (let i = 0; i < 500; i++) expect(newTaskId()).toMatch(/^[0-9a-z]{6}$/);
  });

  test("the Crockford alphabet never contains I, L, O or U", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i++) for (const ch of newPrefixedTaskId("AB").slice(3)) seen.add(ch);
    for (const bad of "ILOU") expect(seen.has(bad)).toBe(false);
    expect(seen.size).toBeGreaterThan(25);
  });

  test("encodeBase pads with the first alphabet character and matches toString(36)", () => {
    expect(encodeBase(0, 6, "0123456789abcdefghijklmnopqrstuvwxyz")).toBe("000000");
    for (const n of [1, 35, 36, 1295, 123456789, BASE36_MAX - 1]) {
      expect(encodeBase(n, 6, "0123456789abcdefghijklmnopqrstuvwxyz")).toBe(
        n.toString(36).padStart(6, "0"),
      );
    }
    expect(encodeBase(BASE36_MAX - 1, 6, "0123456789abcdefghijklmnopqrstuvwxyz")).toBe("zzzzzz");
  });

  test("randomBelow stays in range and covers the range", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = randomBelow(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
      seen.add(v);
    }
    expect(seen.size).toBe(7);
  });

  test("every task id in the Go-generated fixtures matches the TypeScript patterns", () => {
    for (const [name, entry] of Object.entries(manifest.fixtures)) {
      for (const f of fixtureFiles(name).filter((f) => /^\.knowns\/tasks\/.+\.md$/.test(f))) {
        const id = f.split("/").pop()?.slice(0, -3) ?? "";
        expect(`${id}`).toMatch(PREFIXED_TASK_ID_PATTERN);
        expect(DEFAULT_TASK_ID_PATTERN.test(id)).toBe(false);
      }
      expect(entry.files.length).toBeGreaterThan(0);
    }
  });
});

describe("deriveTaskIdPrefix", () => {
  const cases: Record<string, string> = {
    Knowns: "KN",
    knowns: "KN",
    "My Cool Project": "MCP",
    "a b c d e f": "ABCD",
    "my-cool-project": "MCP",
    "42": "TSK",
    "": "TSK",
    "!!!": "TSK",
    X: "TSK",
    "Über Cool": "TSK",
  };
  test.each(Object.entries(cases))("%p -> %p", (name, want) => {
    expect(deriveTaskIdPrefix(name)).toBe(want);
  });

  test("always returns a legal prefix that can mint an ID", () => {
    for (const name of [
      "Knowns",
      "",
      "42",
      "!!!",
      "x",
      "a very long project name indeed",
      "日本語",
      "9lives",
      "A",
      "AB",
      "under_score",
      "  spaced  out  ",
    ]) {
      const prefix = deriveTaskIdPrefix(name);
      expect(() => normalizeTaskIdPrefix(prefix)).not.toThrow();
      expect(() => newPrefixedTaskId(prefix)).not.toThrow();
    }
  });
});

describe("file names", () => {
  test("taskFileName is the id plus .md", () => {
    expect(taskFileName("KN-7F3K9M")).toBe("KN-7F3K9M.md");
    expect(taskFileName("abc123")).toBe("abc123.md");
  });

  test("taskFileMatches accepts the canonical and both legacy forms", () => {
    expect(taskFileMatches("abc123.md", "abc123")).toBe(true);
    expect(taskFileMatches("task-abc123.md", "abc123")).toBe(true);
    expect(taskFileMatches("task-abc123 - My Task.md", "abc123")).toBe(true);
    expect(taskFileMatches("task-abc1234.md", "abc123")).toBe(false);
    expect(taskFileMatches("abc1234.md", "abc123")).toBe(false);
  });

  test("idFromFilename", () => {
    expect(idFromFilename("abc123.md")).toBe("abc123");
    expect(idFromFilename("task-abc123.md")).toBe("abc123");
    expect(idFromFilename("task-abc123 - My Task.md")).toBe("abc123");
    expect(idFromFilename(".md")).toBe("");
  });

  test("sanitizeTitle mirrors models.SanitizeTitle", () => {
    expect(sanitizeTitle("Fix bug: auth/login")).toBe("Fix-bug-authlogin");
    expect(sanitizeTitle("a  b\tc")).toBe("a-b-c");
  });
});
