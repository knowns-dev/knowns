// TSR-9VVJA6 AC2 / spec D10: a project modified by the TypeScript build validates cleanly and
// reads identically under the RELEASED Go 0.34.1, and the reverse direction holds too.
//
// Opt-in (KNOWNS_ROLLBACK_034=1): it needs the released 0.34.1 binary (downloaded once into
// <tmpdir>/knowns-rollback-cache, or KNOWNS_034_BIN) and takes minutes. Everything runs on copies
// in temp dirs with a temp HOME; the repository's own .knowns is only read.
//
// What counts as a failure:
// - `validate` errors, or validate findings on the TS-written project that the SAME writes made by
//   0.34.1 do not produce (ids normalised to their roles);
// - any entity whose JSON reads differently in 0.34.1 than in TS from the same files;
// - after 0.34.1 writes on top, any entity TS reads differently from 0.34.1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { releasedGo, run, type Side, tsSide } from "./binaries.ts";
import { type Ctx, cliScenario, type Ids, mcpScenario, overwriteScenario } from "./scenario.ts";

const enabled = process.env.KNOWNS_ROLLBACK_034 === "1";
const REPO_KNOWNS = resolve(import.meta.dir, "..", "..", "..", ".knowns");
const SLOW = 900_000;
// Each test runs dozens of CLI subprocesses; on a loaded host that exceeds bun's 5 s default, and a
// timed-out test kills the in-flight child (exit -1), which reads like "0.34.1 cannot read it".
const TEST_TIMEOUT = 300_000;

interface Project {
  name: string;
  dir: string;
  home: string;
  env: Record<string, string>;
}

const roots: string[] = [];
function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `knowns-rollback-${prefix}-`)));
  roots.push(d);
  return d;
}

function envFor(home: string): Record<string, string> {
  return {
    HOME: home,
    USERPROFILE: home,
    NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    CI: "1",
    KNOWNS_RUNTIME_INLINE: "1",
    KNOWNS_EMBED_MOCK: "1",
    KNOWNS_SEMANTIC_VECTOR_BACKEND: "sqlite",
    KNOWN_LSP_AUTO_INSTALL: "0",
  };
}

/** A copy of this repository's .knowns (logs dropped), in its own dir with its own HOME. */
function repoCopy(name: string): Project {
  const root = tmp(name);
  const dir = join(root, "proj");
  mkdirSync(dir, { recursive: true });
  cpSync(REPO_KNOWNS, join(dir, ".knowns"), {
    recursive: true,
    filter: (src) => !/[\\/]\.knowns[\\/]logs([\\/]|$)/.test(src),
  });
  const home = join(root, "home");
  mkdirSync(home);
  return { name, dir, home, env: envFor(home) };
}

/** An empty project dir; the side under test runs `init`. */
function freshProject(name: string, side: Side): Project {
  const root = tmp(name);
  const dir = join(root, "fresh");
  const home = join(root, "home");
  mkdirSync(dir, { recursive: true });
  mkdirSync(home);
  const p = { name, dir, home, env: envFor(home) };
  const r = run(
    side,
    ["init", "rbfresh", "--no-wizard", "--no-open", "--task-prefix", "RB"],
    dir,
    p.env,
  );
  if (r.code !== 0) throw new Error(`${side.name} init: ${r.stdout}${r.stderr}`);
  return p;
}

const ctx = (side: Side, p: Project): Ctx => ({ side, cwd: p.dir, env: p.env });

interface Issue {
  level: string;
  code: string;
  message: string;
  entity: string;
}

function validate(go: Side, p: Project): { errors: number; issues: Issue[] } {
  const r = run(go, ["validate", "--json"], p.dir, p.env);
  const j = JSON.parse(r.stdout) as { errors: number; issues: Issue[] | null };
  return { errors: j.errors, issues: j.issues ?? [] };
}

/** Replace each side's own ids with their roles so both sides' findings can be compared. */
function roleNormaliser(ids: Ids): (s: string) => string {
  const pairs = Object.entries(ids)
    .filter(([, v]) => v !== "")
    .sort((a, b) => b[1].length - a[1].length);
  return (s: string) => {
    let out = s;
    for (const [role, id] of pairs) out = out.split(id).join(`<${role}>`);
    return out;
  };
}

const issueKey = (i: Issue, norm: (s: string) => string) =>
  `${i.level} ${i.code} ${norm(i.entity)} :: ${norm(i.message)}`;

function newIssues(before: Issue[], after: Issue[], norm: (s: string) => string): string[] {
  const base = new Map<string, number>();
  for (const i of before)
    base.set(
      issueKey(i, (s) => s),
      (base.get(issueKey(i, (s) => s)) ?? 0) + 1,
    );
  const out: string[] = [];
  for (const i of after) {
    const raw = issueKey(i, (s) => s);
    const n = base.get(raw) ?? 0;
    if (n > 0) base.set(raw, n - 1);
    else out.push(issueKey(i, norm));
  }
  return out.sort();
}

/** The reads compared between 0.34.1 and TS, for the given ids. */
function reads(ids: Ids): string[][] {
  const r: string[][] = [];
  for (const role of ["t1", "t2", "mt", "t3"]) {
    if (!ids[role]) continue;
    r.push(["task", "view", ids[role] as string, "--json"]);
    r.push(["task", "history", ids[role] as string, "--json"]);
  }
  for (const path of ["rollback/rb-doc-moved", "rollback/rb-gone", "rollback/mcp-rb-doc"]) {
    r.push(["doc", "view", path, "--json"]);
    r.push(["doc", "history", path, "--json"]);
  }
  for (const role of ["m1", "m2", "mm", "mc"]) {
    if (ids[role]) r.push(["memory", "view", ids[role] as string, "--json"]);
  }
  r.push(["memory", "list", "--json"]);
  // Whole-project lists: both binaries parse every task and doc file (811 files in the repo copy).
  r.push(["task", "list", "--json"]);
  r.push(["doc", "list", "--json"]);
  for (const role of ["d1", "d2", "md", "d3"]) {
    if (ids[role]) r.push(["decision", "get", ids[role] as string, "--json"]);
  }
  r.push(["decision", "list", "--json"]);
  r.push(["time", "report", "--from", "2026-01-01", "--to", "2027-12-31", "--json"]);
  r.push(["template", "view", "rb-tpl", "--json"]);
  r.push(["config", "get", "settings.semanticSearch.model", "--plain"]);
  r.push(["search", "Rollback", "--keyword", "--json"]);
  return r;
}

function parseOrText(s: string): unknown {
  try {
    return sortSubtasks(JSON.parse(s));
  } catch {
    return s;
  }
}

/**
 * `subtasks` is derived at read time from the children's `parent` field, not stored. 0.34.1
 * appends it while loading tasks concurrently, so its order is random in 0.34.1 itself (five runs
 * gave five orders); TS returns it sorted, one of those orders.
 */
function sortSubtasks(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortSubtasks);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const [k, x] of Object.entries(o)) {
      o[k] = k === "subtasks" && Array.isArray(x) ? [...(x as string[])].sort() : sortSubtasks(x);
    }
  }
  return v;
}

/** Every read whose output differs between the two binaries on the same files. */
function readDiffs(go: Side, ts: Side, p: Project, ids: Ids): string[] {
  const diffs: string[] = [];
  for (const args of reads(ids)) {
    const g = run(go, args, p.dir, p.env);
    const t = run(ts, args, p.dir, p.env);
    // Go builds `time report` rows from a map, so their order is random in 0.34.1 itself.
    const shape = (s: string) =>
      args[1] === "report" ? s.split("\n").sort().join("\n") : parseOrText(s);
    const gv = { code: g.code, out: shape(g.stdout) };
    const tv = { code: t.code, out: shape(t.stdout) };
    // Every read targets an entity the scenario created, so 0.34.1 failing to read it is itself a
    // D10 failure, even when TS fails the same way.
    if (g.code !== 0) {
      diffs.push(
        `## ${args.join(" ")}\n 0.34.1 cannot read it (exit ${g.code}): ${g.stdout.slice(0, 600)}${g.stderr.slice(0, 600)}`,
      );
      continue;
    }
    if (JSON.stringify(gv) !== JSON.stringify(tv)) {
      diffs.push(
        `## ${args.join(" ")}\n go(${g.code}): ${g.stdout.slice(0, 1200)}${g.stderr.slice(0, 300)}\n ts(${t.code}): ${t.stdout.slice(0, 1200)}${t.stderr.slice(0, 300)}`,
      );
    }
  }
  return diffs;
}

describe.skipIf(!enabled)("rollback to released 0.34.1 (D10)", () => {
  let go: Side;
  const ts = tsSide();

  beforeAll(async () => {
    go = { name: "go", cmd: [await releasedGo()] };
    const v = run(go, ["--version"], tmpdir(), envFor(tmp("ver")));
    expect(v.stdout.trim()).toBe("knowns version 0.34.1");
  }, SLOW);

  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  for (const kind of ["repo copy", "fresh init"] as const) {
    describe(kind, () => {
      // The project TS writes, and the oracle project 0.34.1 writes the same way.
      let tsProj: Project;
      let goProj: Project;
      let tsIds: Ids = {};
      let goIds: Ids = {};
      let baseline: Issue[] = [];

      beforeAll(async () => {
        if (kind === "repo copy") {
          tsProj = repoCopy("ts");
          goProj = repoCopy("go");
          baseline = validate(go, tsProj).issues;
        } else {
          tsProj = freshProject("ts-fresh", ts);
          goProj = freshProject("go-fresh", go);
          baseline = [];
        }
        tsIds = cliScenario(ctx(ts, tsProj));
        tsIds = { ...tsIds, ...(await mcpScenario(ctx(ts, tsProj), tsIds)) };
        goIds = cliScenario(ctx(go, goProj));
        goIds = { ...goIds, ...(await mcpScenario(ctx(go, goProj), goIds)) };
      }, SLOW);

      test(
        "0.34.1 validates the TS-written project with no errors and no findings its own writes lack",
        () => {
          const t = validate(go, tsProj);
          const g = validate(go, goProj);
          expect(t.errors).toBe(0);
          const goBaseline = kind === "repo copy" ? baseline : [];
          const tsNew = newIssues(baseline, t.issues, roleNormaliser(tsIds));
          const goNew = newIssues(goBaseline, g.issues, roleNormaliser(goIds));
          const goSet = new Set(goNew);
          expect(tsNew.filter((i) => !goSet.has(i))).toEqual([]);
        },
        TEST_TIMEOUT,
      );

      test(
        "every TS-written entity reads the same in 0.34.1 as in TS",
        () => {
          expect(readDiffs(go, ts, tsProj, tsIds).join("\n\n")).toBe("");
        },
        TEST_TIMEOUT,
      );

      test(
        "after 0.34.1 writes on top, TS reads every entity the same as 0.34.1 and it still validates",
        () => {
          const more = overwriteScenario(ctx(go, tsProj), tsIds);
          const ids = { ...tsIds, ...more };
          expect(readDiffs(go, ts, tsProj, ids).join("\n\n")).toBe("");
          expect(validate(go, tsProj).errors).toBe(0);
          // And TS can keep writing on top of 0.34.1's writes.
          overwriteScenario(ctx(ts, tsProj), ids);
          expect(validate(go, tsProj).errors).toBe(0);
        },
        TEST_TIMEOUT,
      );
    });
  }
});
