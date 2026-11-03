// AC-1: every model schema parses every golden fixture the Go 0.34.1 binary produced.
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { projectSchema } from "../src/models/config.ts";
import { decisionEntrySchema, decisionFrontmatterSchema } from "../src/models/decision.ts";
import { docFrontmatterSchema, docSchema } from "../src/models/doc.ts";
import { memoryEntrySchema, memoryFrontmatterSchema } from "../src/models/memory.ts";
import { resolvedEntitySchema, semanticResolutionSchema } from "../src/models/reference.ts";
import { retrievalResponseSchema, searchResultSchema } from "../src/models/search.ts";
import { taskFrontmatterSchema, taskSchema } from "../src/models/task.ts";
import { templateSchema, templateYamlSchema } from "../src/models/template.ts";
import { timeEntriesFileSchema, timeStateSchema } from "../src/models/time.ts";
import {
  docVersionHistorySchema,
  historyRecordSchema,
  taskVersionHistorySchema,
} from "../src/models/version.ts";
import { workspacesFileSchema } from "../src/models/workspace.ts";
import { parseBoundary } from "../src/schema/index.ts";
import {
  extractAC,
  extractSection,
  parseJsonPreservingNumbers,
  splitFrontmatter,
} from "../src/storage/core/util.ts";
import { fixtureFiles, fixtureNames, manifest, readFixture } from "./helpers/fixtures.ts";

const frontmatter = (text: string) => {
  const { yaml, body } = splitFrontmatter(text);
  return { fm: yaml === "" ? {} : (Bun.YAML.parse(yaml) as unknown), body };
};

describe("fixture manifest", () => {
  test("records the Go version and every fixture directory", () => {
    expect(manifest.goVersion).toBe("0.34.1");
    for (const name of fixtureNames) {
      expect(
        fixtureFiles(name)
          .filter((f) => f !== "manifest.json")
          .sort(),
      ).toEqual([...(manifest.fixtures[name]?.files ?? [])].sort());
    }
  });
});

for (const name of fixtureNames) {
  describe(`fixture ${name}`, () => {
    const files = fixtureFiles(name);

    test("config.json parses as models.Project (BOM tolerated)", () => {
      const raw = readFixture(name, ".knowns/config.json");
      const project = parseBoundary(projectSchema, parseJsonPreservingNumbers(raw), "config.json");
      expect(project.settings.statuses).toContain("done");
      expect(project.schemaVersion).toBe(1);
      expect(project.settings.taskLifecycle?.archiveAfter).toBe("30d");
      expect(project.settings.taskLifecycle?.purgeAfter).toBeNull();
    });

    test("time.json, time-entries.json, workspaces.json, chats.json", () => {
      const read = (f: string) => parseJsonPreservingNumbers(readFixture(name, `.knowns/${f}`));
      parseBoundary(timeStateSchema, read("time.json"), "time.json");
      parseBoundary(timeEntriesFileSchema, read("time-entries.json"), "time-entries.json");
      parseBoundary(workspacesFileSchema, read("workspaces.json"), "workspaces.json");
      expect(read("chats.json")).toEqual([]);
    });

    test("task markdown (tasks/ and archive/) parses as taskFrontmatter + body sections", () => {
      for (const f of files.filter((f) => /^\.knowns\/(tasks|archive)\/.+\.md$/.test(f))) {
        const { fm, body } = frontmatter(readFixture(name, f));
        const task = parseBoundary(taskFrontmatterSchema, fm, f);
        expect(f.endsWith(`/${task.id}.md`)).toBe(true);
        expect(typeof extractSection(body, "DESCRIPTION")).toBe("string");
        expect(Array.isArray(extractAC(body))).toBe(true);
      }
    });

    test("doc markdown parses as docFrontmatter", () => {
      for (const f of files.filter((f) => /^\.knowns\/docs\/.+\.md$/.test(f))) {
        const { fm } = frontmatter(readFixture(name, f));
        const doc = parseBoundary(docFrontmatterSchema, fm, f);
        expect(doc.title.length).toBeGreaterThan(0);
        if (manifest.fixtures[name]?.bomFiles?.includes(f)) {
          expect(readFixture(name, f).startsWith("﻿")).toBe(true);
        } else {
          expect(doc.id).toMatch(/^doc-[0-9a-f]{32}$/);
        }
      }
    });

    test("decision markdown parses as decisionFrontmatter", () => {
      for (const f of files.filter((f) => /^\.knowns\/decisions\/.+\.md$/.test(f))) {
        const { fm } = frontmatter(readFixture(name, f));
        const d = parseBoundary(decisionFrontmatterSchema, fm, f);
        expect(f.endsWith(`/${d.id}.md`)).toBe(true);
      }
    });

    test("memory markdown (project and global) parses as memoryFrontmatter", () => {
      for (const f of files.filter((f) => /memory\/memory-.+\.md$/.test(f))) {
        const { fm } = frontmatter(readFixture(name, f));
        const m = parseBoundary(memoryFrontmatterSchema, fm, f);
        expect(f.endsWith(`memory-${m.id}.md`)).toBe(true);
      }
    });

    test("template _template.yaml parses as the template schema", () => {
      for (const f of files.filter((f) => f.endsWith("/_template.yaml"))) {
        const t = parseBoundary(
          templateYamlSchema,
          Bun.YAML.parse(readFixture(name, f)) as unknown,
          f,
        );
        expect(t.name.length).toBeGreaterThan(0);
        expect(t.actions?.[0]?.type).toBe("add");
      }
    });

    test("every history JSONL line parses as HistoryRecord and the stream is ordered", () => {
      const streams = files.filter((f) => /^\.knowns\/history\/(tasks|docs)\/.+\.jsonl$/.test(f));
      for (const f of streams) {
        const lines = readFixture(name, f).split("\n").filter(Boolean);
        expect(lines.length).toBeGreaterThan(0);
        let prevHash: string | undefined;
        lines.forEach((line, i) => {
          const rec = parseBoundary(historyRecordSchema, JSON.parse(line), `${f}:${i + 1}`);
          expect(rec.revision).toBe(i + 1);
          expect(rec.prevRecordHash).toBe(prevHash);
          prevHash = rec.recordHash;
        });
      }
    });
  });
}

describe("fixture full: the Go --json output parses as the API models", () => {
  const api = (n: string) => JSON.parse(readFixture("full", `_api/${n}.json`)) as unknown;
  const apiFiles = fixtureFiles("full")
    .filter((f) => f.startsWith("_api/"))
    .map((f) => f.slice(5, -5));

  test("covers every API shape", () => {
    expect(apiFiles.length).toBeGreaterThanOrEqual(30);
  });

  test("task view and list", () => {
    for (const n of apiFiles.filter((n) => /^task\.[a-z]+\.view$/.test(n))) {
      const t = parseBoundary(taskSchema, api(n), n);
      expect(t.id).toMatch(/^[A-Z][A-Z0-9]{1,7}-[0-9A-HJKMNP-TV-Z]{6}$/);
    }
    parseBoundary(z.array(taskSchema), api("task.list"), "task.list");
    const rich = parseBoundary(taskSchema, api("task.rich.view"), "rich");
    expect(rich.acceptanceCriteria?.every((a) => a.completed)).toBe(true);
    expect(rich.fulfills).toEqual(["AC-1", "AC-2"]);
    expect(rich.order).toBe(3);
    expect(parseBoundary(taskSchema, api("task.parent.view"), "parent").archived).toBe(true);
  });

  test("Go prints nil slices as null and the schema accepts that", () => {
    const plain = parseBoundary(taskSchema, api("task.plain.view"), "plain");
    expect(plain.labels).toBeNull();
    expect(plain.acceptanceCriteria).toBeNull();
  });

  test("doc view, list, history", () => {
    for (const n of apiFiles.filter((n) => /^doc\..+\.view$/.test(n))) {
      parseBoundary(docSchema, api(n), n);
    }
    parseBoundary(z.array(docSchema), api("doc.list"), "doc.list");
    const hist = parseBoundary(docVersionHistorySchema, api("doc.guide.history"), "history");
    expect(hist.currentVersion).toBeGreaterThanOrEqual(4);
  });

  test("task history", () => {
    const hist = parseBoundary(taskVersionHistorySchema, api("task.rich.history"), "history");
    expect(hist.versions?.[0]?.id).toBe("v1");
  });

  test("decisions", () => {
    for (const n of apiFiles.filter((n) => /^decision\..+\.get$/.test(n))) {
      parseBoundary(decisionEntrySchema, api(n), n);
    }
    const list = parseBoundary(z.array(decisionEntrySchema), api("decision.list"), "list");
    const statuses = new Set(
      ["draft", "superseded", "accepted"].map(
        (s) => parseBoundary(decisionEntrySchema, api(`decision.${s}.get`), s).status,
      ),
    );
    expect(statuses).toEqual(new Set(["draft", "superseded", "accepted"]));
    expect(list.length).toBeGreaterThan(0);
  });

  test("memories", () => {
    for (const n of apiFiles.filter((n) => /^memory\..+\.view$/.test(n))) {
      parseBoundary(memoryEntrySchema, api(n), n);
    }
    parseBoundary(z.array(memoryEntrySchema), api("memory.list"), "memory.list");
  });

  test("templates", () => {
    parseBoundary(templateSchema, api("template.component.view"), "view");
    parseBoundary(z.array(templateSchema), api("template.list"), "list");
  });

  test("search, retrieve, resolve", () => {
    parseBoundary(z.array(searchResultSchema), api("search.login"), "search");
    parseBoundary(retrievalResponseSchema, api("retrieve.bun"), "retrieve");
    for (const n of ["resolve.task", "resolve.doc", "resolve.decision"]) {
      const r = parseBoundary(semanticResolutionSchema, api(n), n);
      expect(r.found).toBe(true);
    }
    parseBoundary(resolvedEntitySchema, { type: "task", id: "x" }, "entity");
  });
});

describe("schemas reject malformed input", () => {
  test("a task without an id", () => {
    expect(() => parseBoundary(taskFrontmatterSchema, { title: "x" }, "task")).toThrow(
      /invalid task/,
    );
  });
  test("a non RFC 3339 timestamp", () => {
    expect(() =>
      parseBoundary(
        docSchema,
        { path: "a", title: "a", createdAt: "yesterday", updatedAt: "x" },
        "doc",
      ),
    ).toThrow(/createdAt/);
  });
});
