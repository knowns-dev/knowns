// A memory file with an explicit empty `metadata: {}` hashes like Go's CanonicalMemoryHash.
// Go's YAML decoder yields an empty (non-nil) map for `{}`, which marshals as `{}`; an absent or
// null `metadata` is a nil map and marshals as `null`.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorage } from "../../../src/storage/adapters.ts";
import { Store } from "../../../src/storage/core/store.ts";
import { canonicalMemoryHash } from "../../../src/storage/history/index.ts";
import { hasGoHelper, runHelper } from "../../helpers/go-helper.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const file = (id: string, metadata: string) => `---
id: ${id}
title: Hash edge ${id}
layer: project
category: pattern
status: active
confidence: high
lastVerified: '2026-11-03T10:00:00Z'
tags:
  - edge
${metadata}createdAt: '2026-11-03T10:00:00Z'
updatedAt: '2026-11-03T10:00:00Z'
---

Body for ${id}.
`;

const cases: [string, string][] = [
  ["emptymap", "metadata: {}\n"],
  ["nullmap", "metadata:\n"],
  ["absent", ""],
  ["filled", "metadata:\n  a: b\n"],
];

const suite = hasGoHelper() ? describe : describe.skip;

suite("canonicalMemoryHash with explicit empty metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "knowns-memhash-edge-"));
  dirs.push(dir);
  const root = join(dir, ".knowns");
  const home = join(dir, "home");
  mkdirSync(join(root, "memory"), { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const [id, meta] of cases)
    writeFileSync(join(root, "memory", `memory-${id}.md`), file(id, meta));
  const storage = createStorage(Store.open(root), { globalRoot: join(home, ".knowns") });

  for (const [id] of cases) {
    test(`metadata variant ${id} equals Go`, () => {
      const [go] = runHelper(["memhash", root, "project", id], home);
      expect(canonicalMemoryHash(storage.memory.getInLayer(id, "project"))).toBe(go as string);
    });
  }

  test("`metadata: {}` and an absent metadata hash differently, as in Go", () => {
    const a = canonicalMemoryHash(storage.memory.getInLayer("emptymap", "project"));
    const b = canonicalMemoryHash(storage.memory.getInLayer("absent", "project"));
    expect(a).not.toBe(b);
  });
});
