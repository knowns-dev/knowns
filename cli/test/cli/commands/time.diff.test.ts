// `knowns time` against the Go 0.34.1 binary, including the active-timer fixture (one running and
// one paused timer). Skipped without KNOWNS_GO_BIN. See harness.ts for what is normalised and why;
// here that includes elapsed/stopped durations, which Go computes from the wall clock, and the row
// order of multi-task reports, which Go takes from a map (random).
import { describe, expect, test } from "bun:test";
import { hasGoBin, makePair, normalized, type Pair, runBoth, treesOf } from "./harness.ts";

interface StepOptions {
  sortLines?: boolean;
}

async function step(pair: Pair, args: string[], opts: StepOptions = {}): Promise<void> {
  const run = await runBoth(pair, args);
  const n = normalized(pair, run);
  const canon = (r: { stdout: string }) =>
    opts.sortLines ? { ...r, stdout: r.stdout.split("\n").sort().join("\n") } : r;
  expect({ args, ...canon(n.ts) }).toEqual({ args, ...canon(n.go) });
}

function sameTree(pair: Pair): void {
  const trees = treesOf(pair);
  expect(Object.keys(trees.ts)).toEqual(Object.keys(trees.go));
  expect(trees.ts).toEqual(trees.go);
}

function clockSensitive(pair: Pair): Pair {
  pair.norm.elapsed = true;
  pair.norm.durations = true;
  return pair;
}

const RUNNING = "TM-B9YGFM";
const PAUSED = "TM-Q3M99R";

describe.skipIf(!hasGoBin)("time on the active-timer fixture", () => {
  test("status, pause, resume and stop with explicit and implicit task ids", async () => {
    const pair = clockSensitive(makePair("active-timer"));
    const steps: string[][] = [
      ["time", "status"],
      ["time", "status", "--plain"],
      ["time", "status", "--json"],
      ["time", "stop"],
      ["time", "pause"],
      ["time", "resume"],
      ["time", "pause", RUNNING],
      ["time", "pause", RUNNING],
      ["time", "status", "--plain"],
      ["time", "resume", PAUSED],
      ["time", "resume", PAUSED],
      ["time", "resume"],
      ["time", "pause", "nope"],
      ["time", "resume", "nope"],
      ["time", "stop", "nope"],
      ["time", "stop", RUNNING],
      ["time", "stop", RUNNING],
      ["time", "status"],
      ["time", "pause"],
      ["time", "resume"],
      ["time", "stop"],
      ["time", "status", "--plain"],
      ["time", "log", RUNNING],
      ["time", "log", RUNNING, "--plain"],
      ["task", RUNNING, "--plain"],
      ["task", "history", RUNNING, "--plain"],
    ];
    for (const args of steps) await step(pair, args);
    sameTree(pair);
  });

  test("the timer shows on task view while it runs", async () => {
    const pair = clockSensitive(makePair("active-timer"));
    await step(pair, ["task", RUNNING, "--plain"]);
    await step(pair, ["task", RUNNING]);
    await step(pair, ["task", PAUSED, "--json"]);
    await step(pair, ["task", PAUSED, "--plain"]);
    sameTree(pair);
  });

  test("a stale expected hash rejects the stop and leaves the timer running", async () => {
    const pair = clockSensitive(makePair("active-timer"));
    await step(pair, ["time", "stop", RUNNING, "--expected-hash", "deadbeef"]);
    await step(pair, ["time", "status", "--plain"]);
    sameTree(pair);
  });
});

describe.skipIf(!hasGoBin)("time start and add", () => {
  test("start, duplicate start, archived and missing tasks", async () => {
    const pair = clockSensitive(makePair("full"));
    const steps: string[][] = [
      ["time", "start", "nope"],
      ["time", "start", "FX-3GCY37"],
      ["time", "start", "FX-60REC2"],
      ["time", "start", "FX-60REC2"],
      ["time", "status", "--plain"],
      ["time", "start"],
      ["time", "pause"],
      ["time", "status", "--plain"],
      ["time", "resume"],
      ["time", "stop"],
      ["time", "stop"],
      ["time", "log", "FX-60REC2", "--plain"],
    ];
    for (const args of steps) await step(pair, args);
    sameTree(pair);
  });

  test("manual entries, dates, notes and their validation", async () => {
    const pair = clockSensitive(makePair("full"));
    const steps: string[][] = [
      ["time", "add", "FX-60REC2", "1h30m", "-n", "first note", "-d", "2026-10-01"],
      ["time", "add", "FX-60REC2", "45m", "--date", "2026-10-02"],
      ["time", "add", "FX-60REC2", "2h"],
      ["time", "add", "FX-60REC2", "2h", "-d", "2026-10-01"],
      ["time", "add", "FX-60REC2", "90s", "-d", "2026-10-03", "--note", 'ninety, "quoted"'],
      ["time", "add", "FX-60REC2", "0s", "-d", "2026-10-04"],
      ["time", "add", "FX-60REC2", "xyz"],
      ["time", "add", "FX-60REC2", ""],
      ["time", "add", "FX-60REC2", "1h", "-d", "not-a-date"],
      ["time", "add", "FX-60REC2", "1h", "-d", "2026-13-01"],
      ["time", "add", "FX-60REC2", "1h", "-d", "2026-02-30"],
      ["time", "add", "FX-60REC2", "1h", "-d", "2026-1-05"],
      ["time", "add", "FX-60REC2", "1h", "-d", "2026-01-05x"],
      ["time", "add", "FX-60REC2", "1h", "-d", "2026"],
      ["time", "add", "nope", "1h"],
      ["time", "add", "FX-3GCY37", "1h"],
      ["time", "add", "FX-60REC2", "1h", "--expected-hash", "deadbeef"],
      ["time", "add", "FX-60REC2"],
      ["time", "log", "FX-60REC2"],
      ["time", "log", "FX-60REC2", "--plain"],
      ["time", "log", "FX-3VT2SR"],
      ["time", "log", "FX-3VT2SR", "--plain"],
      ["task", "FX-60REC2", "--plain"],
      ["task", "history", "FX-60REC2", "--plain"],
    ];
    for (const args of steps) await step(pair, args);
    sameTree(pair);
  });
});

describe.skipIf(!hasGoBin)("time report", () => {
  async function seeded(): Promise<Pair> {
    const pair = clockSensitive(makePair("full"));
    await step(pair, ["time", "add", "FX-60REC2", "1h30m", "-d", "2026-10-01", "-n", "a"]);
    await step(pair, ["time", "add", "FX-60REC2", "30m", "-d", "2026-10-15"]);
    await step(pair, ["task", "edit", "FX-60REC2", "--labels", "backend,api"]);
    return pair;
  }

  // The fixture already holds entries for FX-3VT2SR, so even these reports have several tasks and
  // Go's map order decides their rows: compare lines sorted.
  test("reports in every format (rows compared sorted)", async () => {
    const pair = await seeded();
    const steps: string[][] = [
      ["time", "report"],
      ["time", "report", "--plain"],
      ["time", "report", "--csv"],
      ["time", "report", "--csv", "--plain", "--by-label"],
      ["time", "report", "--by-status"],
      ["time", "report", "--by-status", "--plain"],
      ["time", "report", "--from", "2026-10-10"],
      ["time", "report", "--to", "2026-10-01"],
      ["time", "report", "--to", "2026-09-30", "--plain"],
      ["time", "report", "--from", "2026-10-01", "--to", "2026-10-31", "--csv"],
      ["time", "report", "--from", "0001-01-01"],
      ["time", "report", "--from", "bad"],
      ["time", "report", "--to", "2026-02-31"],
    ];
    for (const args of steps) await step(pair, args, { sortLines: true });
    sameTree(pair);
  });

  test("multi-task reports (row order is random in Go, so lines are compared sorted)", async () => {
    const pair = await seeded();
    await step(pair, ["time", "add", "FX-X82CAD", "2h", "-d", "2026-10-02", "-n", "other"]);
    await step(pair, ["time", "add", "FX-19XJKQ", "10m", "-d", "2026-10-03"]);
    await step(pair, ["task", "edit", "FX-X82CAD", "--labels", "backend"]);
    const sorted = { sortLines: true };
    await step(pair, ["time", "report"], sorted);
    await step(pair, ["time", "report", "--plain"], sorted);
    await step(pair, ["time", "report", "--csv"], sorted);
    await step(pair, ["time", "report", "--by-label"], sorted);
    await step(pair, ["time", "report", "--by-label", "--plain"], sorted);
    await step(pair, ["time", "report", "--by-status"], sorted);
    await step(pair, ["time", "report", "--by-status", "--plain"], sorted);
    sameTree(pair);
  });

  test("empty history", async () => {
    const pair = makePair("empty");
    for (const args of [
      ["time", "report"],
      ["time", "report", "--plain"],
      ["time", "report", "--csv"],
      ["time", "report", "--by-label"],
      ["time", "status"],
      ["time", "status", "--plain"],
      ["time", "log", "nope"],
      ["time", "log", "nope", "--plain"],
    ]) {
      await step(pair, args);
    }
    sameTree(pair);
  });
});

describe.skipIf(!hasGoBin)("time help and argument errors", () => {
  const cases: string[][] = [
    ["time"],
    ["time", "--help"],
    ["help", "time"],
    ["time", "start", "--help"],
    ["time", "stop", "--help"],
    ["time", "pause", "--help"],
    ["time", "resume", "--help"],
    ["time", "add", "--help"],
    ["time", "status", "--help"],
    ["time", "report", "--help"],
    ["time", "log", "--help"],
    ["time", "start"],
    ["time", "start", "a", "b"],
    ["time", "stop", "a", "b"],
    ["time", "add", "only-one"],
    ["time", "log"],
    ["time", "nope"],
    ["time", "report", "--from"],
    ["time", "report", "--nope"],
  ];
  const pair = makePair("empty");
  for (const args of cases) test(args.join(" "), () => step(pair, args));
});
