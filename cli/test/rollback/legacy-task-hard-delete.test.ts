// TSR-481DH6 (D12 divergence): hard-delete a Task whose only history is the legacy path-keyed
// versions/task-<id>.json written by the RELEASED 0.25.0. Opt-in with the other rollback tests.
//
// Root cause, identical in 0.34.1 and TS: hard-delete phase 1 saves the tombstone (reserving the
// ID), then the purge bootstrap reconciles the Task and, finding no id-keyed stream, migrates the
// legacy history through VersionStore.saveVersion, which refuses a reserved ID. 0.34.1 reports
// `cannot save version for hard-deleted Task`, and every retry fails the same way while the Task
// stays visible but frozen (no edit, no timer). TS now converts the legacy history before the
// bootstrap, so the delete completes and an already-stuck Task can be retried.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { must, releasedGo, releasePlatform, run, type Side, tsSide } from "./binaries.ts";

const enabled =
  process.env.KNOWNS_ROLLBACK_034 === "1" &&
  releasePlatform("0.25.0") !== undefined &&
  releasePlatform("0.34.1") !== undefined;
const SLOW = 900_000;
const TEST_TIMEOUT = 300_000;
const HD = ["--yes", "--allow-hard-delete", "--reason", "rollback test"];

const roots: string[] = [];

/** Every file under .knowns whose path or content names the Task, with the id replaced. */
function footprint(knowns: string, id: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      const rel = p.slice(knowns.length + 1).replaceAll("\\", "/");
      if (rel.startsWith("logs/")) continue;
      const inPath = rel.includes(id);
      const inBody = !inPath && readFileSync(p, "utf8").includes(id);
      if (inPath || inBody) out.push(`${inPath ? "path" : "body"} ${rel.split(id).join("<id>")}`);
    }
  };
  walk(knowns);
  return out.sort();
}

describe.skipIf(!enabled)("hard-delete of a Task with only legacy 0.25.0 history", () => {
  let old: Side;
  let go: Side;
  const ts = tsSide();
  let dir = "";
  let env: Record<string, string> = {};
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    old = { name: "go", cmd: [await releasedGo("0.25.0")] };
    go = { name: "go", cmd: [await releasedGo("0.34.1")] };
    const root = realpathSync(mkdtempSync(join(tmpdir(), "knowns-legacy-hd-")));
    roots.push(root);
    dir = join(root, "proj");
    const home = join(root, "home");
    mkdirSync(dir, { recursive: true });
    mkdirSync(home);
    env = {
      HOME: home,
      USERPROFILE: home,
      NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
      CI: "1",
      KNOWNS_RUNTIME_INLINE: "1",
      KNOWN_LSP_AUTO_INSTALL: "0",
    };
    must(old, ["init", "legacy", "--no-wizard"], dir, env);
    for (const role of ["fresh", "stuck", "control"]) {
      const out = must(
        old,
        ["task", "create", `Legacy ${role}`, "-d", "written by 0.25.0"],
        dir,
        env,
      );
      ids[role] = /Created task (\S+?):/.exec(out)?.[1] ?? "";
      expect(ids[role]).not.toBe("");
      must(
        old,
        ["task", "edit", ids[role] as string, "--append-notes", "second legacy version"],
        dir,
        env,
      );
    }
    // Genuinely legacy: path-keyed versions, no id-keyed stream.
    const versions = readdirSync(join(dir, ".knowns", "versions"));
    for (const id of Object.values(ids)) expect(versions).toContain(`task-${id}.json`);
    // Doc ids are irrelevant here (no Docs), so the reconciler can scan the store.
  }, SLOW);

  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  test(
    "0.34.1 fails and leaves the Task frozen (the bug, in the released binary)",
    () => {
      const id = ids.stuck as string;
      const r = run(go, ["task", "hard-delete", id, ...HD], dir, env);
      expect(r.code).not.toBe(0);
      expect(r.stdout + r.stderr).toContain(`cannot save version for hard-deleted Task "${id}"`);
      expect(run(go, ["task", "view", id, "--plain"], dir, env).code).toBe(0); // still visible
      const edit = run(go, ["task", "edit", id, "-t", "renamed"], dir, env);
      expect(edit.stdout + edit.stderr).toContain("cannot save version for hard-deleted Task");
      const retry = run(go, ["task", "hard-delete", id, ...HD], dir, env);
      expect(retry.code).not.toBe(0); // and a retry never gets out of it
    },
    TEST_TIMEOUT,
  );

  test(
    "TS hard-deletes a fresh legacy Task",
    () => {
      const id = ids.fresh as string;
      const r = run(ts, ["task", "hard-delete", id, ...HD], dir, env);
      expect(`${r.code} ${r.stdout}`).toMatch(/^0 [\s\S]*completed=true/);
      expect(run(go, ["task", "view", id, "--plain"], dir, env).stderr).toContain("not found");
      expect(run(ts, ["task", "view", id, "--plain"], dir, env).stderr).toContain("not found");
    },
    TEST_TIMEOUT,
  );

  test(
    "TS completes the delete 0.34.1 left stuck",
    () => {
      const id = ids.stuck as string;
      const r = run(ts, ["task", "hard-delete", id, ...HD], dir, env);
      expect(`${r.code} ${r.stdout}`).toMatch(/^0 [\s\S]*completed=true/);
      expect(run(go, ["task", "view", id, "--plain"], dir, env).stderr).toContain("not found");
    },
    TEST_TIMEOUT,
  );

  test(
    "the end state equals 0.34.1's own successful path, and 0.34.1 validates it",
    () => {
      // 0.34.1's own way through: an edit migrates the legacy history before any reservation,
      // after which its hard-delete succeeds.
      const id = ids.control as string;
      must(go, ["task", "edit", id, "--append-notes", "migrated by 0.34.1"], dir, env);
      const g = run(go, ["task", "hard-delete", id, ...HD], dir, env);
      expect(`${g.code} ${g.stdout}`).toMatch(/^0 [\s\S]*completed=true/);
      const knowns = join(dir, ".knowns");
      const control = footprint(knowns, id);
      expect(control.length).toBeGreaterThan(0); // at least the tombstone; not a vacuous match
      expect(footprint(knowns, ids.fresh as string)).toEqual(control);
      expect(footprint(knowns, ids.stuck as string)).toEqual(control);
      const v = JSON.parse(must(go, ["validate", "--json"], dir, env)) as { errors: number };
      expect(v.errors).toBe(0);
      expect(must(ts, ["validate", "--json"], dir, env)).toBe(
        must(go, ["validate", "--json"], dir, env),
      );
    },
    TEST_TIMEOUT,
  );
});
