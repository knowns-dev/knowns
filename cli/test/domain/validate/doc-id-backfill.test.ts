// TSR-WR33ZF: `validate` reports legacy Docs without a stable id (TS-only DOC_MISSING_ID, info),
// and `validate --fix` inserts exactly one `id:` line, the way Go's writeFile would place it.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertDocId } from "../../../src/domain/validate/doc-id-backfill.ts";
import { run } from "../../../src/domain/validate/validate.ts";
import { createStorage } from "../../../src/storage/adapters.ts";
import { Store } from "../../../src/storage/core/store.ts";
import { parseDocContent, renderDoc } from "../../../src/storage/stores/doc-store.ts";

const LEGACY = `---
title: Legacy Doc
description: Written before stable ids
createdAt: '2026-01-02T03:04:05.000Z'
updatedAt: '2026-01-02T03:04:05.000Z'
tags:
  - legacy
---

# Legacy Doc

Body.
`;

const ID = "doc-0123456789abcdef0123456789abcdef";

describe("insertDocId", () => {
  test("adds one first frontmatter line and keeps every other byte", () => {
    const out = insertDocId(LEGACY, ID) as string;
    expect(out).toBe(LEGACY.replace("---\n", `---\nid: ${ID}\n`));
  });

  test("a canonical legacy file becomes exactly Go's renderDoc output for that Doc with the id", () => {
    const out = insertDocId(LEGACY, ID) as string;
    const parsed = parseDocContent(out, "legacy", "", false, "");
    expect(parsed.id).toBe(ID);
    expect(renderDoc(parsed)).toBe(out);
  });

  test("keeps CRLF and a BOM", () => {
    const crlf = `﻿${LEGACY.replaceAll("\n", "\r\n")}`;
    const out = insertDocId(crlf, ID) as string;
    expect(out).toBe(crlf.replace("---\r\n", `---\r\nid: ${ID}\r\n`));
    expect(parseDocContent(out, "legacy", "", false, "").id).toBe(ID);
  });

  test("no frontmatter means nothing to insert into", () => {
    expect(insertDocId("# Just a body\n", ID)).toBeUndefined();
  });
});

function project(docs: Record<string, string>): {
  root: string;
  storage: ReturnType<typeof createStorage>;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "knowns-docid-")));
  const k = join(root, ".knowns");
  mkdirSync(join(k, "docs"), { recursive: true });
  mkdirSync(join(k, "tasks"), { recursive: true });
  writeFileSync(join(k, "config.json"), JSON.stringify({ name: "docid", settings: {} }, null, 2));
  for (const [path, body] of Object.entries(docs)) {
    const abs = join(k, "docs", `${path}.md`);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return { root, storage: createStorage(Store.open(k)) /* the knowledge root */ };
}

function treeHash(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice(dir.length)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

const WITH_ID = LEGACY.replace("---\n", `---\nid: ${ID}\n`);

describe("validate DOC_MISSING_ID", () => {
  test("without --fix: one info issue per legacy Doc, nothing written, validity unchanged", () => {
    const p = project({ "a/legacy": LEGACY, "b/legacy-two": LEGACY, current: WITH_ID });
    const before = treeHash(p.root);
    const r = run(p.storage, {});
    const missing = r.issues.filter((i) => i.code === "DOC_MISSING_ID");
    expect(missing.map((i) => [i.level, i.entity, i.fixed])).toEqual([
      ["info", "a/legacy", undefined],
      ["info", "b/legacy-two", undefined],
    ]);
    expect(r.valid).toBe(true);
    // --strict promotes warnings only, so the info issue never changes validity.
    expect(run(p.storage, { strict: true }).valid).toBe(true);
    expect(treeHash(p.root)).toEqual(before);
  });

  test("--fix: each legacy Doc gets one `id:` line, nothing else changes, and a rerun is clean", () => {
    const p = project({ "a/legacy": LEGACY, current: WITH_ID });
    const docs = join(p.root, ".knowns", "docs");
    const before = treeHash(p.root);
    const r = run(p.storage, { fix: true });
    const fixed = r.issues.filter((i) => i.code === "DOC_MISSING_ID");
    expect(fixed).toHaveLength(1);
    expect(fixed[0]?.fixed).toBe(true);
    const id = /Assigned stable id (doc-[0-9a-f]{32})$/.exec(fixed[0]?.message ?? "")?.[1];
    expect(id).toBeDefined();
    expect(readFileSync(join(docs, "a", "legacy.md"), "utf8")).toBe(
      LEGACY.replace("---\n", `---\nid: ${id}\n`),
    );
    const after = treeHash(p.root);
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    expect(changed).toEqual([join("/.knowns", "docs", "a", "legacy.md")]);
    expect(run(p.storage, {}).issues.filter((i) => i.code === "DOC_MISSING_ID")).toEqual([]);
  });

  test("--entity limits the fix to that Doc", () => {
    const p = project({ one: LEGACY, two: LEGACY });
    run(p.storage, { fix: true, entity: "one" });
    const left = run(p.storage, {}).issues.filter((i) => i.code === "DOC_MISSING_ID");
    expect(left.map((i) => i.entity)).toEqual(["two"]);
  });

  test("a Doc with no frontmatter is reported, not rewritten", () => {
    const p = project({ bare: "# Bare\n\nNo frontmatter.\n" });
    const before = treeHash(p.root);
    const r = run(p.storage, { fix: true });
    const iss = r.issues.filter((i) => i.code === "DOC_MISSING_ID");
    expect(iss.map((i) => [i.level, i.fixed])).toEqual([["warning", undefined]]);
    expect(treeHash(p.root)).toEqual(before);
  });

  test("a store without legacy Docs gets no DOC_MISSING_ID issue, with or without --fix", () => {
    const p = project({ current: WITH_ID });
    const before = treeHash(p.root);
    for (const fix of [false, true]) {
      expect(run(p.storage, { fix }).issues.filter((i) => i.code === "DOC_MISSING_ID")).toEqual([]);
    }
    expect(treeHash(p.root)).toEqual(before);
  });
});
