// Storage utilities (internal/storage/util.go) and the on-disk text formats.
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureStoreGitignore, STORE_IGNORE_PATTERNS } from "../src/storage/core/store-clone.ts";
import {
  atomicWrite,
  decodeGenericObject,
  extractAC,
  extractSection,
  getNestedKey,
  goJsonStringify,
  goTrimSpace,
  parseJsonPreservingNumbers,
  readJson,
  renderAC,
  renderSection,
  sanitizeFileSlug,
  setNestedKey,
  sortKeysDeep,
  splitFrontmatter,
  stripBom,
  writeCanonicalJson,
  writeJson,
} from "../src/storage/core/util.ts";
import { fixtureFiles, fixtureId, readFixture } from "./helpers/fixtures.ts";

const dir = mkdtempSync(join(tmpdir(), "knowns-util-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("atomicWrite", () => {
  test("creates parent directories, writes the content, leaves no temp file, mode 0600", () => {
    const dst = join(dir, "a", "b", "file.md");
    atomicWrite(dst, "hello");
    expect(readFileSync(dst, "utf8")).toBe("hello");
    expect(readdirSync(join(dir, "a", "b"))).toEqual(["file.md"]);
    if (process.platform !== "win32") expect(statSync(dst).mode & 0o777).toBe(0o600);
  });

  test("replaces an existing file", () => {
    const dst = join(dir, "replace.txt");
    atomicWrite(dst, "one");
    atomicWrite(dst, "two");
    expect(readFileSync(dst, "utf8")).toBe("two");
  });
});

describe("Go-compatible JSON", () => {
  test("escapes <, >, & and the line separators like encoding/json", () => {
    expect(goJsonStringify({ a: "<b>&  " }, 0)).toBe(
      '{"a":"\\u003cb\\u003e\\u0026\\u2028\\u2029"}',
    );
    expect(goJsonStringify({ a: 1, b: [] }, 2)).toBe('{\n  "a": 1,\n  "b": []\n}');
  });

  test("canonical JSON sorts keys recursively and ends with a newline", () => {
    const path = join(dir, "canon.json");
    writeCanonicalJson(path, { b: { z: 1, a: [{ y: 1, x: 2 }] }, a: null });
    expect(readFileSync(path, "utf8")).toBe(
      '{\n  "a": null,\n  "b": {\n    "a": [\n      {\n        "x": 2,\n        "y": 1\n      }\n    ],\n    "z": 1\n  }\n}\n',
    );
  });

  test("keys sort by UTF-8 bytes like Go map keys", () => {
    expect(Object.keys(sortKeysDeep({ é: 1, z: 1, a: 1 }) as object)).toEqual(["a", "z", "é"]);
  });

  test("numbers that JS cannot round-trip survive a read-modify-write", () => {
    const text = '{"a":1.0,"b":12345678901234567890,"c":1e3,"d":[0.10],"e":42}';
    const obj = decodeGenericObject(text);
    expect(obj.e).toBe(42);
    const out = goJsonStringify(obj, 0);
    expect(out).toBe(text.replace(/\s/g, ""));
  });

  test("a BOM is tolerated on read", () => {
    expect(parseJsonPreservingNumbers('﻿{"a":1}')).toEqual({ a: 1 });
    const path = join(dir, "bom.json");
    writeFileSync(path, "﻿[1,2]");
    expect(readJson(path)).toEqual([1, 2]);
  });

  test("writeJson output equals what Go wrote for the same value (time.json)", () => {
    const goText = readFixture("empty", ".knowns/time.json");
    const path = join(dir, "time.json");
    writeJson(path, JSON.parse(goText));
    expect(readFileSync(path, "utf8")).toBe(goText);
  });

  test("every Go-written JSON fixture file re-serializes byte for byte", () => {
    for (const name of ["empty", "full", "active-timer"]) {
      for (const f of fixtureFiles(name).filter((f) =>
        /\.knowns\/(time|time-entries|workspaces|chats)\.json$/.test(f),
      )) {
        const text = readFixture(name, f);
        expect(`${goJsonStringify(parseJsonPreservingNumbers(text))}\n`, `${name}/${f}`).toBe(text);
      }
    }
  });

  test("Go's canonical config.json round-trips byte for byte through sorted-key serialization", () => {
    for (const name of ["empty", "full", "active-timer"]) {
      const text = readFixture(name, ".knowns/config.json");
      expect(`${goJsonStringify(sortKeysDeep(parseJsonPreservingNumbers(text)))}\n`, name).toBe(
        text,
      );
    }
  });
});

describe("BOM and whitespace", () => {
  test("stripBom", () => {
    expect(stripBom("﻿abc")).toBe("abc");
    expect(stripBom("abc")).toBe("abc");
  });
  test("goTrimSpace trims U+0085 but not U+FEFF, unlike String.trim", () => {
    expect(goTrimSpace("\u0085 x  ")).toBe("x");
    expect(goTrimSpace("﻿x")).toBe("﻿x");
  });
});

describe("frontmatter", () => {
  test("splits YAML and body, LF and CRLF, with and without BOM", () => {
    expect(splitFrontmatter("---\nid: a\n---\nbody\n")).toEqual({ yaml: "id: a", body: "body\n" });
    expect(splitFrontmatter("---\r\nid: a\r\n---\r\nbody\r\n")).toEqual({
      yaml: "id: a",
      body: "body\r\n",
    });
    expect(splitFrontmatter("﻿---\nid: a\n---\nbody")).toEqual({ yaml: "id: a", body: "body" });
  });
  test("no frontmatter or an unterminated block yields an empty YAML and the whole content", () => {
    expect(splitFrontmatter("just text")).toEqual({ yaml: "", body: "just text" });
    expect(splitFrontmatter("---\nid: a\nno end")).toEqual({
      yaml: "",
      body: "---\nid: a\nno end",
    });
  });
  test("every Go-written markdown fixture splits cleanly", () => {
    for (const f of fixtureFiles("full").filter((f) => f.endsWith(".md"))) {
      const { yaml, body } = splitFrontmatter(readFixture("full", f));
      expect(yaml, f).not.toBe("");
      expect(body.length, f).toBeGreaterThan(0);
    }
  });
});

describe("sections and acceptance criteria", () => {
  const body = [
    "# T",
    "<!-- SECTION:DESCRIPTION:BEGIN -->",
    "the description",
    "<!-- SECTION:DESCRIPTION:END -->",
    "<!-- BEGIN:plan -->",
    "legacy plan",
    "<!-- END:plan -->",
    "<!-- AC:BEGIN -->",
    "- [ ] #1 first",
    "- [x] #2 second one",
    "- [X] no number",
    "<!-- AC:END -->",
  ].join("\n");

  test("extractSection reads current and legacy markers", () => {
    expect(extractSection(body, "DESCRIPTION")).toBe("the description");
    expect(extractSection(body, "PLAN")).toBe("legacy plan");
    expect(extractSection(body, "NOTES")).toBe("");
  });

  test("extractAC / renderAC", () => {
    const ac = extractAC(body);
    expect(ac).toEqual([
      { text: "first", completed: false },
      { text: "second one", completed: true },
      { text: "no number", completed: true },
    ]);
    expect(renderAC(ac)).toBe("- [ ] #1 first\n- [x] #2 second one\n- [x] #3 no number");
    expect(renderAC([])).toBe("");
  });

  test("renderSection strips existing markers and handles empty content", () => {
    expect(
      renderSection("notes", "<!-- SECTION:NOTES:BEGIN -->\nx\n<!-- SECTION:NOTES:END -->"),
    ).toBe("<!-- SECTION:NOTES:BEGIN -->\nx\n<!-- SECTION:NOTES:END -->");
    expect(renderSection("plan", "  ")).toBe(
      "<!-- SECTION:PLAN:BEGIN -->\n<!-- SECTION:PLAN:END -->",
    );
  });

  test("a rich Go-written task: frontmatter, description, plan, notes and criteria come back as written", () => {
    const id = fixtureId("full", "task.rich");
    const { yaml, body: b } = splitFrontmatter(readFixture("full", `.knowns/tasks/${id}.md`));
    const fm = Bun.YAML.parse(yaml) as Record<string, unknown>;
    expect(fm).toMatchObject({
      id,
      title: "Implement login flow (v2)",
      status: "done",
      priority: "high",
      assignee: "@fixture",
      spec: "specs/login",
      fulfills: ["AC-1", "AC-2"],
      labels: ["auth", "feature", "shipped"],
      order: 3,
      timeSpent: 8100,
    });
    expect(extractSection(b, "DESCRIPTION")).toBe(
      "Users sign in with email and password.\n\nSecond paragraph with `code` and a | pipe.",
    );
    expect(extractSection(b, "PLAN")).toBe("1. Design\n2. Build\n3. Test");
    expect(extractSection(b, "NOTES")).toBe("Initial notes\n\nImplemented the happy path");
    expect(extractAC(b)).toEqual([
      { text: "User can log in", completed: true },
      { text: "Bad passwords are rejected", completed: true },
      { text: "Sessions expire after 24h", completed: true },
    ]);
  });
});

describe("misc helpers", () => {
  test("sanitizeFileSlug (legacy task file slug): 50 chars, hyphen runs, trimmed", () => {
    expect(sanitizeFileSlug("Fix: unicode 日本語 / title")).toBe("Fix-unicode-日本語-title");
    expect(sanitizeFileSlug("---")).toBe("");
    expect(sanitizeFileSlug("a".repeat(80))).toBe("a".repeat(50));
  });

  test("dot-notation keys", () => {
    const m: Record<string, unknown> = {};
    setNestedKey(m, "settings.a.b", 1);
    setNestedKey(m, "settings.c", [1]);
    expect(m).toEqual({ settings: { a: { b: 1 }, c: [1] } });
    expect(getNestedKey(m, "settings.a.b")).toEqual({ found: true, value: 1 });
    expect(getNestedKey(m, "settings.a.b.c")).toEqual({ found: false });
    expect(getNestedKey(m, "nope")).toEqual({ found: false });
    setNestedKey(m, "settings.c.d", 2);
    expect(m.settings).toMatchObject({ c: { d: 2 } });
  });
});

describe("ensureStoreGitignore (store_clone.go)", () => {
  const BEGIN = "# >>> knowns: machine-local state, never synced (store spec D1) >>>";
  const END = "# <<< knowns <<<";

  test("creates the managed block, then is idempotent", () => {
    const clone = mkdtempSync(join(dir, "clone-"));
    expect(ensureStoreGitignore(clone)).toBe(true);
    const text = readFileSync(join(clone, ".gitignore"), "utf8");
    expect(text).toBe(`${BEGIN}\n${STORE_IGNORE_PATTERNS.join("\n")}\n${END}\n`);
    expect(ensureStoreGitignore(clone)).toBe(false);
  });

  test("preserves the team's own lines and replaces a stale block in place", () => {
    const clone = mkdtempSync(join(dir, "clone-"));
    writeFileSync(join(clone, ".gitignore"), `node_modules\n${BEGIN}\nold\n${END}\nlast`);
    expect(ensureStoreGitignore(clone)).toBe(true);
    expect(readFileSync(join(clone, ".gitignore"), "utf8")).toBe(
      `node_modules\n${BEGIN}\n${STORE_IGNORE_PATTERNS.join("\n")}\n${END}\nlast`,
    );
  });

  test("appends after a final line without a newline", () => {
    const clone = mkdtempSync(join(dir, "clone-"));
    writeFileSync(join(clone, ".gitignore"), "dist");
    ensureStoreGitignore(clone);
    expect(readFileSync(join(clone, ".gitignore"), "utf8").startsWith(`dist\n${BEGIN}\n`)).toBe(
      true,
    );
  });

  test("an unterminated block is an error", () => {
    const clone = mkdtempSync(join(dir, "clone-"));
    writeFileSync(join(clone, ".gitignore"), `${BEGIN}\nx\n`);
    expect(() => ensureStoreGitignore(clone)).toThrow(/unterminated knowns block/);
    expect(existsSync(join(clone, ".gitignore"))).toBe(true);
  });
});
