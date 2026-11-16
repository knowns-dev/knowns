// A reindex stopped at a safe point keeps what it indexed; the next run does not redo it.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { IndexService } from "../../src/runtime/index/index-service.ts";
import { JobCancelledError } from "../../src/runtime/job-cancel.ts";
import { MockEmbedder } from "../../src/search/mock-embedder.ts";
import { SQLiteVectorStore } from "../../src/search/sqlite-store.ts";
import { createStorage } from "../../src/storage/adapters.ts";
import { Store } from "../../src/storage/core/store.ts";
import { dispose, makeProject, type Project } from "../reconcile/harness.ts";

const projects: Project[] = [];
afterEach(() => {
  for (const p of projects.splice(0)) dispose(p);
});

class Counting extends MockEmbedder {
  calls = 0;
  override async embed(text: string): Promise<Float32Array> {
    this.calls++;
    return super.embed(text);
  }
  override async embedBatch(texts: string[]): Promise<Float32Array[]> {
    this.calls += texts.length;
    return super.embedBatch(texts);
  }
}

test("stops between sources with JobCancelledError and resumes without redoing finished work", async () => {
  const p = makeProject("full");
  projects.push(p);
  const root = join(p.dir, ".knowns");
  const storage = createStorage(Store.open(root));
  const embedder = new Counting();
  const open = () => {
    const s = new SQLiteVectorStore(
      join(root, ".search"),
      embedder.modelConfig().name,
      embedder.dimensions(),
    );
    s.load();
    return s;
  };

  // A full run, to know the cost and the count of sources.
  const full = open();
  await new IndexService(storage, embedder, full).reindex();
  const fullCalls = embedder.calls;
  const sources = full.listContentHashes().size;
  expect(sources).toBeGreaterThan(2);
  full.clear?.();
  full.save();

  // Stop after the first progress ticks.
  embedder.calls = 0;
  let asked = 0;
  const partial = open();
  const stopAfter = 2;
  await expect(
    new IndexService(storage, embedder, partial).reindex(undefined, () => ++asked > stopAfter),
  ).rejects.toBeInstanceOf(JobCancelledError);
  const doneFirst = embedder.calls;
  expect(doneFirst).toBeGreaterThan(0);
  expect(doneFirst).toBeLessThan(fullCalls);
  expect(partial.listContentHashes().size).toBeGreaterThan(0);
  expect(partial.listContentHashes().size).toBeLessThan(sources);

  // The next run does only the rest.
  embedder.calls = 0;
  const resumed = open();
  await new IndexService(storage, embedder, resumed).reindex();
  expect(embedder.calls).toBeLessThan(fullCalls);
  expect(embedder.calls + doneFirst).toBeLessThanOrEqual(fullCalls);
  expect(resumed.listContentHashes().size).toBe(sources);
});
