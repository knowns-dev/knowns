// Go-vs-TS differential session for the remaining tools: project, validate, initial, time,
// memory, decision, search, templates and the code tool's argument and error paths.
import { afterAll, describe, expect, test } from "bun:test";
import { withoutD13 } from "../helpers/d13.ts";
import { firstDiff, hasGoBin, runDiff, type Step } from "./harness.ts";

const sortById = (text: string): string => {
  try {
    const v = JSON.parse(text);
    const key = (x: { id?: string; key?: string; taskId?: string }) =>
      x.id ?? x.key ?? x.taskId ?? "";
    const cmp = (a: object, b: object) => key(a).localeCompare(key(b));
    if (Array.isArray(v)) v.sort(cmp);
    for (const k of ["entries", "groups", "results"]) if (Array.isArray(v?.[k])) v[k].sort(cmp);
    return JSON.stringify(v, null, 2);
  } catch {
    return text;
  }
};

const steps: Step[] = [
  { tool: "initial", args: {}, normalize: (t) => t.replace(/idle=\S+/g, "idle=<X>") },
  { tool: "initial", args: { x: 1 } },
  { tool: "project", args: { action: "current" } },
  { tool: "project", args: { action: "status" }, normalize: stripLsp },
  { tool: "project", args: { action: "detect" } },
  { tool: "project", args: (c) => ({ action: "set", projectRoot: c.v.dir ?? "/nonexistent" }) },
  { tool: "validate", args: {} },
  { tool: "validate", args: { scope: "sdd", strict: true } },
  { tool: "validate", args: { scope: "tasks", entity: "FX-19XJKQ" } },
  { tool: "validate", args: { fix: true } },
  { tool: "templates", args: { action: "list" } },
  { tool: "templates", args: { action: "get", name: "component" } },
  { tool: "templates", args: { action: "get", name: "nope" } },
  {
    tool: "templates",
    args: { action: "run", name: "component", variables: { name: "x", n: 3, b: true } },
  },
  { tool: "templates", args: { action: "run", name: "component", dryRun: false } },
  { tool: "templates", args: { action: "create", name: "newtpl", description: "d" } },
  { tool: "templates", args: { action: "create", name: "newtpl" } },
  { tool: "time", args: { action: "start", taskId: "FX-19XJKQ" } },
  { tool: "time", args: { action: "start", taskId: "FX-19XJKQ" } },
  { tool: "time", args: { action: "start", taskId: "NOPE-1" } },
  {
    tool: "time",
    args: { action: "stop", taskId: "FX-19XJKQ" },
    normalize: (t) =>
      t
        .replace(/"duration": \d+/g, '"duration": N')
        .replace(/Duration: \S+/, "Duration: D")
        .replace(/te-\d+-/, "te-<MS>-"),
  },
  { tool: "time", args: { action: "stop", taskId: "FX-19XJKQ" } },
  {
    tool: "time",
    args: { action: "add", taskId: "FX-19XJKQ", duration: "1h30m", note: "n", date: "2026-01-02" },
  },
  { tool: "time", args: { action: "add", taskId: "FX-19XJKQ", duration: "bogus" } },
  { tool: "time", args: { action: "add", taskId: "FX-19XJKQ" } },
  { tool: "time", args: { action: "report" }, normalize: sortById },
  {
    tool: "time",
    args: { action: "report", from: "2026-01-01", to: "2026-01-02", groupBy: "status" },
    normalize: sortById,
  },
  { tool: "time", args: { action: "report", groupBy: "label" }, normalize: sortById },
  { tool: "time", args: { action: "report", groupBy: "task" }, normalize: sortById },
  { tool: "memory", args: { action: "list" } },
  { tool: "memory", args: { action: "list", includeAll: true, layer: "global" } },
  { tool: "memory", args: { action: "list", layer: "bogus" } },
  { tool: "memory", args: { action: "list", status: "bogus" } },
  { tool: "memory", args: { action: "get", id: "kunv9q" } },
  { tool: "memory", args: { action: "get", id: "zzzzzz" } },
  { tool: "memory", args: { action: "add" } },
  { tool: "memory", args: { action: "add", content: "x", category: "decision" } },
  { tool: "memory", args: { action: "add", content: "x", category: "bogus" } },
  { tool: "memory", args: { action: "add", content: "x", category: "preference" } },
  { tool: "memory", args: { action: "add", content: "x", layer: "x" } },
  { tool: "memory", args: { action: "add", content: "x", status: "x" } },
  {
    tool: "memory",
    args: {
      action: "add",
      title: "Brand new fact",
      content: "First paragraph.\n\nSecond paragraph.",
      category: "pattern",
      tags: ["a"],
      sources: ["@doc/x"],
      confidence: "high",
      key: "k1",
    },
    capture: { name: "m1", re: /"id": "([a-z0-9]+)"/ },
  },
  {
    tool: "memory",
    args: { action: "add", title: "Brand new fact", content: "Replaced.", key: "k1" },
  },
  { tool: "memory", args: (c) => ({ action: "get", id: c.v.m1 }) },
  {
    tool: "memory",
    args: (c) => ({
      action: "update",
      id: c.v.m1,
      title: "T2",
      tags: ["z"],
      lastVerified: "2026-01-01T00:00:00Z",
    }),
  },
  { tool: "memory", args: (c) => ({ action: "update", id: c.v.m1, lastVerified: "bad" }) },
  {
    tool: "memory",
    args: (c) => ({ action: "update", id: c.v.m1, clear: ["category"], status: "stale" }),
  },
  { tool: "memory", args: (c) => ({ action: "confirm", id: c.v.m1 }) },
  { tool: "memory", args: (c) => ({ action: "contradict", id: c.v.m1 }) },
  { tool: "memory", args: (c) => ({ action: "contradict", id: c.v.m1, note: "wrong" }) },
  { tool: "memory", args: (c) => ({ action: "promote", id: c.v.m1 }) },
  { tool: "memory", args: (c) => ({ action: "demote", id: c.v.m1 }) },
  { tool: "memory", args: { action: "cleanup" } },
  { tool: "memory", args: { action: "cleanup", olderThanDays: 1, limit: 1, layer: "global" } },
  { tool: "memory", args: { action: "resolve" } },
  { tool: "memory", args: { action: "resolve", resolution: "bogus" } },
  { tool: "memory", args: (c) => ({ action: "delete", id: c.v.m1 }) },
  { tool: "memory", args: (c) => ({ action: "delete", id: c.v.m1, dryRun: false }) },
  { tool: "decision", args: { action: "list" } },
  { tool: "decision", args: { action: "list", includeAll: true, tag: "x" } },
  { tool: "decision", args: { action: "list", status: "bogus" } },
  { tool: "decision", args: { action: "get", id: "20261103-1337-adopt-a-monorepo" } },
  { tool: "decision", args: { action: "get", id: "nope" } },
  { tool: "decision", args: { action: "create" } },
  {
    tool: "decision",
    args: {
      action: "create",
      title: "A brand new decision",
      body: "b",
      context: "c",
      decision: "d",
      tags: ["t"],
    },
    capture: { name: "d1", re: /"id": "([0-9a-z-]+)"/ },
  },
  { tool: "decision", args: (c) => ({ action: "link", id: c.v.d1, relatedDocs: ["specs/login"] }) },
  { tool: "decision", args: { action: "review_inbox" } },
  { tool: "decision", args: (c) => ({ action: "accept", id: c.v.d1 }) },
  { tool: "decision", args: { action: "resolve" } },
  { tool: "decision", args: { action: "supersede", oldId: "a", newId: "b" } },
  { tool: "decision", args: { action: "migration_preview" } },
  { tool: "decision", args: { action: "migration_apply" } },
  { tool: "decision", args: { action: "migration_rollback" } },
  { tool: "search", args: { action: "search", query: "login" }, normalize: sortById },
  {
    tool: "search",
    args: { action: "search", query: "login", type: "doc", mode: "keyword", limit: 1 },
  },
  { tool: "search", args: { action: "search", query: "zzqqxx" } },
  { tool: "search", args: { action: "search" } },
  {
    tool: "search",
    args: {
      action: "retrieve",
      query: "login",
      mode: "keyword",
      sourceTypes: ["doc", "task"],
      expandReferences: true,
    },
  },
  { tool: "search", args: { action: "retrieve", query: "login" } },
  { tool: "search", args: { action: "resolve", ref: "@doc/specs/login" } },
  {
    tool: "search",
    args: { action: "resolve", ref: "@doc/specs/login", direction: "both", depth: 2 },
  },
  { tool: "search", args: { action: "resolve", ref: "@doc/nope" } },
  { tool: "code", args: { action: "symbols" } },
  { tool: "code", args: { action: "symbols", path: "../etc/passwd" } },
  { tool: "code", args: { action: "find" } },
  { tool: "code", args: { action: "replace" } },
  {
    tool: "code",
    args: { action: "replace", path: ".knowns/config.json", needle: "a", repl: "b" },
  },
  { tool: "code", args: { action: "replace", path: ".git/config", needle: "a", repl: "b" } },
  { tool: "code", args: { action: "replace", path: "nope.txt", needle: "a", repl: "b" } },
  { tool: "code", args: { action: "replace", path: "src.txt", needle: "a", repl: "b", mode: "x" } },
  { tool: "code", args: { action: "search" } },
  { tool: "code", args: { action: "graph" } },
  { tool: "code", args: { action: "nope" } },
  { tool: "code", args: { action: "rename", path: "x.ts" } },
  {
    tool: "help",
    args: {
      queries: [
        "tasks.*",
        "code.*",
        "docs.*",
        "memory.*",
        "decision",
        "workflow.*",
        "project.*",
        "search.*",
        "time.*",
        "templates.*",
        "validate.*",
        "help.*",
        "insert",
        "zzz",
      ],
    },
  },
  { tool: "help", args: { queries: [] } },
];

function stripLsp(t: string): string {
  try {
    const v = JSON.parse(t);
    v.lsp = undefined;
    // The Go oracle is built without the release ldflags and reports "dev".
    v.version = undefined;
    return JSON.stringify(v, null, 2);
  } catch {
    return t;
  }
}

describe.skipIf(!hasGoBin)("remaining tools match Go", () => {
  let session: Awaited<ReturnType<typeof runDiff>> | undefined;
  afterAll(async () => {
    await session?.close();
  });
  test("session", async () => {
    session = await runDiff("full", steps, {
      setup: (dir) => {
        Bun.write(`${dir}/src.txt`, "a a a\n");
      },
    });
    for (const r of session.results) r.tsMasked = withoutD13(r.tsMasked);
    const diffs = session.results.filter((r) => r.goMasked !== r.tsMasked);
    if (diffs.length > 0) {
      console.log(
        diffs.map((d) => `--- ${d.label}\n${firstDiff(d.goMasked, d.tsMasked)}`).join("\n\n"),
      );
    }
    expect(diffs.length).toBe(0);
  }, 300_000);
});
