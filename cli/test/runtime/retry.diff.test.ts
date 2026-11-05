// AC3: `knowns runtime retry` releases dead-lettered Qdrant jobs exactly as Go 0.34.1 does:
// same stdout/stderr/exit code in every mode, same queue file afterwards.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Pair } from "../cli/commands/harness.ts";
import { hasGoBin, INLINE, makePair, mask, runSide, runtimeSnapshot } from "./helpers.ts";

const suite = hasGoBin ? describe : describe.skip;

function queueFile(pair: Pair, side: "go" | "ts"): string {
  const dir = join(pair[side].home, ".knowns", "runtime", "queues");
  const name = readdirSync(dir).find((n) => n.endsWith(".json"));
  if (!name) throw new Error("no queue file");
  return join(dir, name);
}

/** Dead-letters the queue's first job (attempts exhausted) and adds a second, live one. */
function deadLetter(pair: Pair, side: "go" | "ts"): string[] {
  const path = queueFile(pair, side);
  const state = JSON.parse(readFileSync(path, "utf8"));
  const ids: string[] = [];
  for (const [i, job] of state.jobs.entries()) {
    if (i < 2) {
      job.deadLetter = true;
      job.attempts = 8;
      job.lastError = "dial tcp 127.0.0.1:6333: connect: connection refused";
      job.runAfter = new Date(Date.now() + 86_400_000).toISOString();
      ids.push(job.id);
    }
  }
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  return ids;
}

async function seed(): Promise<{ pair: Pair; ids: { go: string[]; ts: string[] } }> {
  const pair = makePair("full");
  for (const args of [
    ["task", "create", "Retry one", "-d", "x"],
    ["doc", "create", "Retry doc", "-d", "d", "-c", "body"],
    ["task", "create", "Retry three", "-d", "x"],
  ]) {
    await runSide(pair, "go", args, INLINE);
    await runSide(pair, "ts", args, INLINE);
  }
  return { pair, ids: { go: deadLetter(pair, "go"), ts: deadLetter(pair, "ts") } };
}

async function both(pair: Pair, args: (side: "go" | "ts") => string[]) {
  const go = await runSide(pair, "go", args("go"), INLINE);
  const ts = await runSide(pair, "ts", args("ts"), INLINE);
  const norm = (side: "go" | "ts", r: typeof go) => ({
    code: r.code,
    stdout: mask(pair, side, r.stdout),
    stderr: mask(pair, side, r.stderr),
  });
  return { go: norm("go", go), ts: norm("ts", ts) };
}

suite("runtime retry equals Go", () => {
  for (const mode of [[], ["--plain"], ["--json"]]) {
    test(`--dry-run --all ${mode.join(" ")}`, async () => {
      const { pair } = await seed();
      const r = await both(pair, () => ["runtime", "retry", "--all", "--dry-run", ...mode]);
      expect(r.ts).toEqual(r.go);
      expect(r.go.code).toBe(0);
      expect(runtimeSnapshot(pair, "ts")).toEqual(runtimeSnapshot(pair, "go"));
    });
    test(`--all ${mode.join(" ")}`, async () => {
      const { pair } = await seed();
      const r = await both(pair, () => ["runtime", "retry", "--all", ...mode]);
      expect(r.ts).toEqual(r.go);
      // The released jobs are runnable again: same queue (attempts reset, error cleared).
      const go = JSON.parse(readFileSync(queueFile(pair, "go"), "utf8")).jobs;
      const ts = JSON.parse(readFileSync(queueFile(pair, "ts"), "utf8")).jobs;
      expect(go.filter((j: { deadLetter?: boolean }) => j.deadLetter)).toHaveLength(0);
      expect(ts.filter((j: { deadLetter?: boolean }) => j.deadLetter)).toHaveLength(0);
      expect(mask(pair, "ts", JSON.stringify(ts, null, 1))).toEqual(
        mask(pair, "go", JSON.stringify(go, null, 1)),
      );
    });
  }

  test("explicit ids: one dead letter, one live job, one unknown", async () => {
    const { pair, ids } = await seed();
    const path = (side: "go" | "ts") =>
      JSON.parse(readFileSync(queueFile(pair, side), "utf8")).jobs;
    const live = { go: path("go")[2].id as string, ts: path("ts")[2].id as string };
    const r = await both(pair, (side) => [
      "runtime",
      "retry",
      ids[side][0] as string,
      live[side],
      "nope-123",
    ]);
    expect(r.go.code).toBe(1);
    expect(r.ts.code).toBe(1);
    const norm = (side: "go" | "ts", t: string) =>
      t.replaceAll(ids[side][0] as string, "<DEAD>").replaceAll(live[side], "<LIVE>");
    expect(norm("ts", r.ts.stdout)).toEqual(norm("go", r.go.stdout));
    expect(norm("ts", r.ts.stderr)).toEqual(norm("go", r.go.stderr));
  });

  test("argument errors", async () => {
    const pair = makePair("full");
    for (const args of [
      ["runtime", "retry"],
      ["runtime", "retry", "abc", "--all"],
      ["runtime", "retry", "--all", "--all-projects"],
    ]) {
      const r = await both(pair, () => args);
      expect(r.ts).toEqual(r.go);
      if (args.length < 4) expect(r.go.code).toBe(1);
    }
  });
});
