// internal/validate as a library: pure helpers, option handling and a run over a fixture project.
// The full issue catalogue is compared with the Go binary in test/cli/commands/validate.test.ts.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  goQuote,
  looksLikeTaskID,
  markdownSectionContent,
  run,
} from "../../../src/domain/validate/index.ts";
import { createStorage } from "../../../src/storage/adapters.ts";
import { Store } from "../../../src/storage/core/store.ts";
import { fixtureRoot } from "../../helpers/fixtures.ts";

function project(): { storage: ReturnType<typeof createStorage>; dir: string; globalRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), "validate-lib-"));
  cpSync(fixtureRoot("full"), dir, { recursive: true });
  const globalRoot = join(dir, "_home", ".knowns");
  return {
    storage: createStorage(Store.open(join(dir, ".knowns")), { globalRoot }),
    dir,
    globalRoot,
  };
}

describe("looksLikeTaskID", () => {
  test("matches Go", () => {
    expect(looksLikeTaskID("TSR-7B9C9G")).toBe(true);
    expect(looksLikeTaskID("abc123")).toBe(true);
    expect(looksLikeTaskID("guides/setup")).toBe(false);
    expect(looksLikeTaskID("a".repeat(21))).toBe(false);
    expect(looksLikeTaskID("a".repeat(20))).toBe(true);
    expect(looksLikeTaskID("has space")).toBe(false);
    expect(looksLikeTaskID("under_score")).toBe(false);
    expect(looksLikeTaskID("")).toBe(true);
    // The limit is in bytes: ten two-byte characters fit, eleven do not (and are not ASCII anyway).
    expect(looksLikeTaskID("é")).toBe(false);
  });
});

describe("markdownSectionContent", () => {
  const md =
    "# Top\n\nintro\n\n## Locked Decisions\n\n- D1: x\n\n### Sub\n\nsub body\n\n## Next\n\nend";
  test("returns the body up to the next heading of the same or higher level", () => {
    expect(markdownSectionContent(md, "locked decisions")).toBe(
      "\n- D1: x\n\n### Sub\n\nsub body\n",
    );
  });
  test("last section runs to the end", () => {
    expect(markdownSectionContent(md, "Next")).toBe("\nend");
  });
  test("absent", () => {
    expect(markdownSectionContent(md, "Missing")).toBeUndefined();
  });
});

describe("goQuote", () => {
  test("strconv.Quote", () => {
    expect(goQuote('a"b\\c\n\t')).toBe('"a\\"b\\\\c\\n\\t"');
    expect(goQuote("é日本")).toBe('"é日本"');
    expect(goQuote("\x01\x7f")).toBe('"\\x01\\x7f"');
    expect(goQuote("​")).toBe('"\\u200b"');
  });
});

describe("run", () => {
  test("result shape and counts on the golden fixture", () => {
    const { storage, dir } = project();
    try {
      const r = run(storage, {});
      expect(r.issues.length).toBe(r.errorCount + r.warningCount + r.infoCount);
      expect(r.valid).toBe(r.errorCount === 0);
      for (const i of r.issues) {
        expect(["error", "warning", "info"]).toContain(i.level);
        expect(Object.keys(i).slice(0, 3)).toEqual(["level", "code", "message"]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("strict turns warnings into errors", () => {
    const { storage, dir } = project();
    try {
      const loose = run(storage, {});
      const strict = run(storage, { strict: true });
      expect(strict.warningCount).toBe(0);
      expect(strict.errorCount).toBe(loose.errorCount + loose.warningCount);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unknown scope validates nothing", () => {
    const { storage, dir } = project();
    try {
      const r = run(storage, { scope: "nope" });
      expect(r).toEqual({ issues: [], errorCount: 0, warningCount: 0, infoCount: 0, valid: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("memory TTL and proposal age follow the injected clock", () => {
    const { storage, dir } = project();
    try {
      const at = (iso: string) => run(storage, { scope: "memory", now: () => Date.parse(iso) });
      const early = at("2026-11-04T00:00:00Z");
      const late = at("2030-01-01T00:00:00Z");
      expect(early.issues.some((i) => i.code === "MEMORY_OLD_PROPOSED")).toBe(false);
      expect(late.issues.some((i) => i.code === "MEMORY_OLD_PROPOSED")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("no CLI imports", () => {
  test("domain/references and domain/validate do not import src/cli", () => {
    const roots = ["references", "validate"].map((d) =>
      join(import.meta.dir, "..", "..", "..", "src", "domain", d),
    );
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    for (const r of roots) walk(r);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect({ f, imports: /from\s+["'][^"']*\/cli\//.test(readFileSync(f, "utf8")) }).toEqual({
        f,
        imports: false,
      });
    }
  });
});
