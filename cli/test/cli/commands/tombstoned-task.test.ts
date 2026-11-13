// Updates to a Task whose ID is reserved by a hard-delete tombstone (TSR-6ERKFQ). The state is the
// one a hard-delete that stopped after writing its tombstone leaves behind: the canonical file and
// its history are still there, and .knowns/tombstones/tasks/<id>.json exists.
//
// Output and exit code match 0.34.1. Go writes the edited file, fails at SaveTaskVersion and
// rolls the write back (same bytes, new mtime); the TS build checks the reservation first and
// never rewrites the file. That is the one intended difference, and it is asserted here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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
let box: Sandbox;
let id = "";

beforeAll(() => {
  if (!hasGoBin) return;
  box = makeSandbox("knowns-tombstoned-");
  mkdirSync(box.home, { recursive: true });
  mkdirSync(box.proj, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: box.proj });
  goInTemplate(box, ["init", "tomb", "--no-wizard"]);
  const out = goInTemplate(box, ["task", "create", "Half deleted", "--prefix", "KN", "--plain"]);
  id = /KN-[A-Z0-9]+/.exec(out)?.[0] ?? "";
  if (id === "") throw new Error(`no task id in: ${out}`);
  const dir = join(box.proj, ".knowns", "tombstones", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.json`),
    `${JSON.stringify({ id, deletedAt: "2026-11-06T05:35:55.824495Z", actor: "someone", reason: "duplicate" }, null, 2)}`,
  );
}, 60_000);

afterAll(() => {
  if (box) rmSync(box.root, { recursive: true, force: true });
});

const COMMANDS = (taskId: string): string[][] => [
  ["task", "edit", taskId, "--append-notes", "late note"],
  ["task", "edit", taskId, "-s", "done"],
  ["task", "edit", taskId, "--title", "Renamed"],
  ["time", "start", taskId],
];

describe("updates to a tombstoned Task", () => {
  t("match Go's output, exit code and resulting files", async () => {
    for (const args of COMMANDS(id)) {
      const opts = { watch: ["proj/.knowns/tasks", "proj/.knowns/history/tasks"] };
      const go = await runGoIn(box, [...args, "--plain"], opts);
      const ts = await runTsIn(box, [...args, "--plain"], opts);
      expect({ args, ...ts }).toEqual({ args, ...go });
      expect(ts.code).toBe(1);
    }
  });

  t("never rewrite the Task file on the TS side", async () => {
    const entry = join(import.meta.dir, "..", "..", "..", "src", "bin.ts");
    for (const args of COMMANDS(id)) {
      const run = mkdtempSync(join(tmpdir(), "knowns-tomb-run-"));
      try {
        cpSync(box.root, run, { recursive: true });
        const file = join(run, "proj", ".knowns", "tasks", `${id}.md`);
        const before = statSync(file).mtimeMs;
        await Bun.sleep(20);
        const p = Bun.spawn([process.execPath, entry, ...args, "--plain"], {
          cwd: join(run, "proj"),
          env: sandboxEnv(join(run, "home"), { KNOWNS_RUNTIME_INLINE: "1" }),
          stdout: "ignore",
          stderr: "ignore",
        });
        expect(await p.exited).toBe(1);
        expect({ args, mtimeMs: statSync(file).mtimeMs }).toEqual({ args, mtimeMs: before });
      } finally {
        rmSync(run, { recursive: true, force: true });
      }
    }
  });
});
