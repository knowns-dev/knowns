// The daemon's entity jobs on the legacy SQLite backend: with the runtime daemon enabled (not
// inline), a task create queues index-task, each side's own daemon runs it and idles out, and the
// TS daemon puts the task in the SQLite index. Before this the TS daemon failed the job and wrote
// nothing.
//
// Go's index is not asserted: its daemon ignores KNOWNS_EMBED_MOCK (only the inline InitSemantic
// honours it) and calls the real embedder, so whether Go writes the row depends on a local Ollama
// (on a mac with Ollama it wrote the row with qwen3-embedding:0.6b even though the project sets
// all-minilm; on a Linux box without Ollama it wrote nothing). See the TSR-2MPMDK notes.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pair } from "../cli/commands/harness.ts";
import { hasGoBin, INLINE, makePair, runSide, sqliteIndexDump, waitFor } from "./helpers.ts";

const suite = hasGoBin ? describe : describe.skip;
// The default backend is managed Qdrant; the legacy SQLite writer is selected explicitly.
const MOCK = { KNOWNS_EMBED_MOCK: "1", KNOWNS_SEMANTIC_VECTOR_BACKEND: "sqlite" };
const DAEMON = {
  ...MOCK,
  KNOWNS_RUNTIME_IDLE_TIMEOUT_MS: "1500",
  KNOWNS_ENTITY_INDEX_DEBOUNCE_MS: "0",
};

function pidOf(pair: Pair, side: "go" | "ts"): number | undefined {
  const f = join(pair[side].home, ".knowns", "runtime", "knowns-runtime.pid");
  if (!existsSync(f)) return undefined;
  const n = Number.parseInt(readFileSync(f, "utf8"), 10);
  return Number.isFinite(n) ? n : undefined;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

suite("daemon entity jobs write the SQLite index like Go", () => {
  test("task create through the daemon indexes the task", async () => {
    const pair = makePair("full");
    const pids: number[] = [];
    try {
      for (const side of ["go", "ts"] as const) {
        for (const [k, v] of [
          ["settings.semanticSearch.enabled", "true"],
          ["settings.semanticSearch.model", "all-minilm"],
        ]) {
          const r = await runSide(pair, side, ["config", "set", k as string, v as string], {
            ...INLINE,
            ...MOCK,
          });
          expect(r.code, r.stderr).toBe(0);
        }
        const re = await runSide(pair, side, ["search", "--reindex", "--plain"], {
          ...INLINE,
          ...MOCK,
        });
        expect(re.code, re.stderr).toBe(0);
        const c = await runSide(
          pair,
          side,
          ["task", "create", "Daemon indexed", "-d", "written by the daemon"],
          DAEMON,
        );
        expect(c.code, c.stderr).toBe(0);
        expect(await waitFor(() => pidOf(pair, side) !== undefined, 10_000)).toBe(true);
        const pid = pidOf(pair, side) as number;
        pids.push(pid);
        expect(
          await waitFor(() => pidOf(pair, side) === undefined && !alive(pid), 30_000),
          `${side} daemon idles out`,
        ).toBe(true);
      }
      expect(sqliteIndexDump(pair, "ts")).toContain("Daemon indexed");
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }, 120_000);
});
