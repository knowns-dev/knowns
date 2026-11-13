// Task hard-delete in a store the reconcile refuses (TSR-8CXR89): a legacy Doc without a stable
// `id:` makes the bootstrap reconcile refuse every canonical input. Go 0.34.1 reserves the ID
// first (tombstone + pending record), then fails, and the Task is stuck: its file and history
// stay, every update is refused as hard-deleted, and restore calls it not tombstoned. The TS
// build runs the reconcile in preview mode before reserving anything.
//
// Same error text and exit code as Go; the summary says changed=0 where Go says changed=1, and
// nothing is left behind. A store without unsafe inputs deletes exactly as Go does.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasGoBin } from "../oracle.ts";
import {
  goInTemplate,
  makeSandbox,
  runGoIn,
  runTsIn,
  type Sandbox,
  sandboxEnv,
} from "./subprocess-diff.ts";

const t = test.skipIf(!hasGoBin);
const ENTRY = join(import.meta.dir, "..", "..", "..", "src", "bin.ts");
let legacy: Sandbox;
let clean: Sandbox;
let legacyTask = "";
let cleanTask = "";

function project(prefix: string, withLegacyDoc: boolean): { box: Sandbox; task: string } {
  const box = makeSandbox(prefix);
  mkdirSync(box.home, { recursive: true });
  mkdirSync(box.proj, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: box.proj });
  goInTemplate(box, ["init", "purge", "--no-wizard"]);
  goInTemplate(box, ["doc", "create", "legacy-doc", "-c", "written before docs had ids"]);
  if (withLegacyDoc) {
    const doc = join(box.proj, ".knowns", "docs", "legacy-doc.md");
    writeFileSync(doc, readFileSync(doc, "utf8").replace(/^id: .*\n/m, ""));
  }
  const out = goInTemplate(box, ["task", "create", "Victim", "--prefix", "KN", "--plain"]);
  const task = /KN-[A-Z0-9]+/.exec(out)?.[0] ?? "";
  if (task === "") throw new Error(`no task id in: ${out}`);
  return { box, task };
}

beforeAll(() => {
  if (!hasGoBin) return;
  ({ box: legacy, task: legacyTask } = project("knowns-purge-legacy-", true));
  ({ box: clean, task: cleanTask } = project("knowns-purge-clean-", false));
}, 60_000);

afterAll(() => {
  for (const b of [legacy, clean]) if (b) rmSync(b.root, { recursive: true, force: true });
});

const hardDelete = (id: string) => [
  "task",
  "hard-delete",
  id,
  "--allow-hard-delete",
  "--yes",
  "--reason",
  "duplicate",
];

const WATCH = [
  "proj/.knowns/tasks",
  "proj/.knowns/tombstones",
  "proj/.knowns/history/tasks",
  "proj/.knowns/history/purged",
];

describe("task hard-delete and the reconcile preflight", () => {
  t("a store without unsafe inputs deletes exactly as Go does", async () => {
    const go = await runGoIn(clean, hardDelete(cleanTask), { watch: WATCH });
    const ts = await runTsIn(clean, hardDelete(cleanTask), { watch: WATCH });
    // The event id embeds the wall clock.
    // Wall-clock fields: the event id, batch id and timestamps (TS writes milliseconds where Go
    // writes microseconds, a format difference outside this change).
    const mask = (s: string) =>
      s
        .replace(/hard_delete:\d+:[0-9a-f]+/g, "hard_delete:<t>")
        .replace(/"batchId": "batch-[0-9a-f]+"/g, '"batchId": "<b>"')
        .replace(/"(\w+At)": "[^"]+"/g, '"$1": "<t>"');
    const masked = (o: typeof go) => ({
      ...o,
      stdout: mask(o.stdout),
      files: Object.fromEntries(Object.entries(o.files).map(([k, v]) => [k, mask(v)])),
    });
    expect(masked(ts)).toEqual(masked(go));
    expect(ts.code).toBe(0);
    expect(Object.keys(ts.files).some((f) => f.startsWith("proj/.knowns/tasks/"))).toBe(false);
  });

  t("a refused reconcile gives Go's error and exit code", async () => {
    const go = await runGoIn(legacy, hardDelete(legacyTask));
    const ts = await runTsIn(legacy, hardDelete(legacyTask));
    expect(ts.code).toBe(1);
    expect(ts.code).toBe(go.code);
    expect(ts.stderr).toBe(go.stderr);
    expect(ts.stderr).toContain("missing stable Doc id");
    // The intended difference: nothing was reserved, so the summary and the item say unchanged
    // and there is no lifecycle event id.
    expect(go.stdout).toContain("changed=1 completed=false");
    const expected = go.stdout
      .replace("changed=1 completed=false", "changed=0 completed=false")
      .replace(
        / changed=true (eligible=true reasons=operation_failed) eventId=\S+/,
        " changed=false $1",
      );
    expect(ts.stdout).toBe(expected);
  });

  t("a refused reconcile leaves no stuck state behind", async () => {
    const run = mkdtempSync(join(tmpdir(), "knowns-purge-run-"));
    try {
      cpSync(legacy.root, run, { recursive: true });
      const kn = join(run, "proj", ".knowns");
      const ts = (args: string[]) =>
        Bun.spawnSync([process.execPath, ENTRY, ...args, "--plain"], {
          cwd: join(run, "proj"),
          env: sandboxEnv(join(run, "home"), { KNOWNS_RUNTIME_INLINE: "1" }),
        });
      expect(ts(hardDelete(legacyTask)).exitCode).toBe(1);
      expect(existsSync(join(kn, "tombstones", "tasks", `${legacyTask}.json`))).toBe(false);
      expect(existsSync(join(kn, "tasks", `${legacyTask}.md`))).toBe(true);
      // Still a live Task: an update goes through.
      const edit = ts(["task", "edit", legacyTask, "--append-notes", "still alive"]);
      expect(edit.exitCode).toBe(0);
      expect(readFileSync(join(kn, "tasks", `${legacyTask}.md`), "utf8")).toContain("still alive");
      // A retry is refused the same way, still without a tombstone.
      expect(ts(hardDelete(legacyTask)).exitCode).toBe(1);
      expect(existsSync(join(kn, "tombstones", "tasks", `${legacyTask}.json`))).toBe(false);
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  });
});
