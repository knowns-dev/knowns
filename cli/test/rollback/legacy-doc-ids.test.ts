// TSR-WR33ZF end to end, on REAL legacy data: the released 0.25.0 (the last release before stable
// Doc ids) writes the project, TS `validate --fix` backfills the ids, and the released 0.34.1
// must read everything as before. Opt-in with the other rollback tests (KNOWNS_ROLLBACK_034=1).
//
// AC1  validate reports each legacy Doc; --fix inserts one `id:` line and changes no other byte
//      anywhere in the store; each fixed file equals Go's renderDoc for that Doc with the new id.
// AC2  0.34.1 reads every fixed Doc identically (apart from the new id) and validates with 0 errors.
// AC3  doc history (0.34.1 and TS), keyword search and reconcile stay consistent, and a task
//      hard-delete that the legacy Docs blocked now succeeds.
// AC4  without --fix nothing is written.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import { parseDocContent, renderDoc } from "../../src/storage/stores/doc-store.ts";
import { must, releasedGo, releasePlatform, run, type Side, tsSide } from "./binaries.ts";

const enabled =
  process.env.KNOWNS_ROLLBACK_034 === "1" &&
  releasePlatform("0.25.0") !== undefined &&
  releasePlatform("0.34.1") !== undefined;
const SLOW = 900_000;
const TEST_TIMEOUT = 300_000;

const DOCS = ["guides/legacy-guide", "guides/second-guide", "notes"];

const roots: string[] = [];
function envFor(home: string): Record<string, string> {
  return {
    HOME: home,
    USERPROFILE: home,
    NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    CI: "1",
    KNOWNS_RUNTIME_INLINE: "1",
    KNOWN_LSP_AUTO_INSTALL: "0",
  };
}

function treeHash(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else
        out[p.slice(dir.length + 1).replaceAll("\\", "/")] = createHash("sha256")
          .update(readFileSync(p))
          .digest("hex");
    }
  };
  walk(dir);
  return out;
}

const changedFiles = (a: Record<string, string>, b: Record<string, string>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

function json(s: string): unknown {
  return JSON.parse(s);
}

/**
 * A doc view without its id and canonicalHash, for before/after comparison. The canonical hash
 * covers the id (Go's CanonicalDocHash), so it changes with any id assignment, including the one
 * Go's own writeFile makes; that 0.34.1 and TS agree on the new hash is asserted separately.
 */
function withoutId(s: string): unknown {
  const j = json(s) as Record<string, unknown>;
  delete j.id;
  delete j.canonicalHash;
  return j;
}

describe.skipIf(!enabled)("legacy Doc ids: 0.25.0 data, TS validate --fix, 0.34.1 reads", () => {
  let old: Side;
  let go: Side;
  const ts = tsSide();
  let dir = "";
  let env: Record<string, string> = {};
  let doomed = "";
  let keeper = "";
  // Captured before the fix.
  const viewBefore = new Map<string, unknown>();
  const historyBefore = new Map<string, { go: string; ts: string }>();
  let searchBefore = "";
  let validateBefore: unknown;

  beforeAll(async () => {
    old = { name: "go", cmd: [await releasedGo("0.25.0")] };
    go = { name: "go", cmd: [await releasedGo("0.34.1")] };
    const root = realpathSync(mkdtempSync(join(tmpdir(), "knowns-legacy-ids-")));
    roots.push(root);
    dir = join(root, "proj");
    const home = join(root, "home");
    mkdirSync(dir, { recursive: true });
    mkdirSync(home);
    env = envFor(home);
    expect(must(old, ["--version"], dir, env).trim()).toBe("knowns version 0.25.0");
    expect(must(go, ["--version"], dir, env).trim()).toBe("knowns version 0.34.1");

    // Legacy project, written entirely by 0.25.0: docs with path-keyed history, and tasks.
    must(old, ["init", "legacy", "--no-wizard"], dir, env);
    must(
      old,
      ["doc", "create", "Legacy Guide", "-d", "first", "-t", "legacy", "-f", "guides"],
      dir,
      env,
    );
    must(
      old,
      ["doc", "edit", "guides/legacy-guide", "-c", "# Legacy Guide\n\nSecond revision body."],
      dir,
      env,
    );
    must(old, ["doc", "edit", "guides/legacy-guide", "-a", "Third revision, appended."], dir, env);
    must(old, ["doc", "create", "Second Guide", "-d", "another", "-f", "guides"], dir, env);
    must(
      old,
      ["doc", "edit", "guides/second-guide", "-c", "Searchable needle-legacy text."],
      dir,
      env,
    );
    must(old, ["doc", "create", "Notes", "-d", "root doc"], dir, env);
    // The tasks to hard-delete are created by current versions in the legacy store. A task that
    // 0.25.0 wrote carries legacy path-keyed history (versions/task-<id>.json) that neither 0.34.1
    // nor TS can hard-delete ("cannot save version for hard-deleted Task"): a separate issue.
    doomed =
      /Created task (\S+?):/.exec(
        must(ts, ["task", "create", "Doomed task", "-d", "x"], dir, env),
      )?.[1] ?? "";
    keeper =
      /Created task (\S+?):/.exec(
        must(go, ["task", "create", "Keeper task", "-d", "x"], dir, env),
      )?.[1] ?? "";
    expect(doomed).not.toBe("");
    expect(keeper).not.toBe("");
    for (const p of DOCS) {
      const raw = readFileSync(join(dir, ".knowns", "docs", `${p}.md`), "utf8");
      expect(raw).not.toMatch(/^id:/m); // genuinely legacy
    }
    expect(
      readdirSync(join(dir, ".knowns", "versions")).filter((f) => f.startsWith("doc-")).length,
    ).toBeGreaterThan(0);

    for (const p of DOCS) {
      viewBefore.set(p, withoutId(must(go, ["doc", "view", p, "--json"], dir, env)));
      historyBefore.set(p, {
        go: must(go, ["doc", "history", p, "--json"], dir, env),
        ts: must(ts, ["doc", "history", p, "--json"], dir, env),
      });
    }
    searchBefore = must(go, ["search", "needle-legacy", "--keyword", "--json"], dir, env);
    validateBefore = json(must(go, ["validate", "--json"], dir, env));
  }, SLOW);

  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  test(
    "the legacy Docs block hard-delete before the fix (the reason for this task)",
    () => {
      const r = run(
        ts,
        [
          "task",
          "hard-delete",
          doomed,
          "--yes",
          "--allow-hard-delete",
          "--reason",
          "rollback test",
        ],
        dir,
        env,
      );
      expect(r.code).not.toBe(0);
      expect(r.stdout + r.stderr).toContain("missing stable Doc id");
    },
    TEST_TIMEOUT,
  );

  test(
    "validate without --fix reports each legacy Doc as info and writes nothing",
    () => {
      const before = treeHash(join(dir, ".knowns"));
      const r = json(must(ts, ["validate", "--json"], dir, env)) as {
        issues: { level: string; code: string; entity: string; fixed?: boolean }[];
        errors: number;
        valid: boolean;
      };
      const missing = r.issues.filter((i) => i.code === "DOC_MISSING_ID");
      expect(missing.map((i) => [i.level, i.entity]).sort()).toEqual(
        DOCS.map((p) => ["info", p]).sort(),
      );
      expect(missing.some((i) => i.fixed)).toBe(false);
      expect(changedFiles(before, treeHash(join(dir, ".knowns")))).toEqual([]);
      // Everything else matches 0.34.1's own validate.
      const others = r.issues.filter((i) => i.code !== "DOC_MISSING_ID");
      const base = validateBefore as { errors: number; valid: boolean; issues: unknown[] | null };
      expect({ errors: r.errors, valid: r.valid, issues: others as unknown[] }).toEqual({
        errors: base.errors,
        valid: base.valid,
        issues: base.issues ?? [],
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "validate --fix inserts exactly one id line per legacy Doc and touches nothing else",
    () => {
      const knowns = join(dir, ".knowns");
      const before = treeHash(knowns);
      const raws = new Map(
        DOCS.map((p) => [p, readFileSync(join(knowns, "docs", `${p}.md`), "utf8")]),
      );
      const r = json(must(ts, ["validate", "--fix", "--json"], dir, env)) as {
        issues: { code: string; entity: string; fixed?: boolean; message: string }[];
      };
      const fixed = r.issues.filter((i) => i.code === "DOC_MISSING_ID");
      expect(fixed.every((i) => i.fixed === true)).toBe(true);
      expect(changedFiles(before, treeHash(knowns))).toEqual(
        DOCS.map((p) => `docs/${p}.md`).sort(),
      );
      for (const p of DOCS) {
        const id = /Assigned stable id (doc-[0-9a-f]{32})$/.exec(
          fixed.find((i) => i.entity === p)?.message ?? "",
        )?.[1];
        expect(id).toBeDefined();
        const after = readFileSync(join(knowns, "docs", `${p}.md`), "utf8");
        expect(after).toBe((raws.get(p) as string).replace("---\n", `---\nid: ${id}\n`));
        // Byte-identical to what Go's writeFile renders for this Doc once it has the id.
        expect(renderDoc(parseDocContent(after, p, "", false, ""))).toBe(after);
      }
      // A second --fix finds nothing to do.
      const again = json(must(ts, ["validate", "--fix", "--json"], dir, env)) as {
        issues: { code: string }[];
      };
      expect(again.issues.filter((i) => i.code === "DOC_MISSING_ID")).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  test(
    "0.34.1 reads every fixed Doc identically and validates with 0 errors",
    () => {
      for (const p of DOCS) {
        const view = json(must(go, ["doc", "view", p, "--json"], dir, env)) as Record<
          string,
          unknown
        >;
        expect(view.id).toMatch(/^doc-[0-9a-f]{32}$/);
        expect(withoutId(JSON.stringify(view))).toEqual(viewBefore.get(p));
        // And TS reads it the same way 0.34.1 does.
        expect(json(must(ts, ["doc", "view", p, "--json"], dir, env))).toEqual(view);
      }
      const v = json(must(go, ["validate", "--json"], dir, env)) as {
        errors: number;
        issues: unknown[] | null;
      };
      expect(v.errors).toBe(0);
      expect(v.issues ?? []).toEqual((validateBefore as { issues: unknown[] | null }).issues ?? []);
    },
    TEST_TIMEOUT,
  );

  test(
    "doc history and keyword search are unchanged by the backfill",
    () => {
      for (const p of DOCS) {
        const h = historyBefore.get(p) as { go: string; ts: string };
        expect(must(go, ["doc", "history", p, "--json"], dir, env)).toBe(h.go);
        expect(must(ts, ["doc", "history", p, "--json"], dir, env)).toBe(h.ts);
      }
      expect(must(go, ["search", "needle-legacy", "--keyword", "--json"], dir, env)).toBe(
        searchBefore,
      );
    },
    TEST_TIMEOUT,
  );

  test(
    "hard-delete now succeeds, and history and reads stay consistent after the reconciler ran",
    () => {
      const r = run(
        ts,
        [
          "task",
          "hard-delete",
          doomed,
          "--yes",
          "--allow-hard-delete",
          "--reason",
          "rollback test",
        ],
        dir,
        env,
      );
      expect(`${r.code} ${r.stdout}${r.stderr}`).toMatch(/^0 /);
      expect(run(go, ["task", "view", doomed, "--json"], dir, env).code).not.toBe(0);
      expect(must(go, ["task", "view", keeper, "--json"], dir, env)).toContain(keeper);
      // The reconciler migrated or adopted each Doc's history; every legacy revision must survive.
      for (const p of DOCS) {
        const before = json((historyBefore.get(p) as { go: string }).go) as {
          versions?: { version: number }[];
        };
        const after = json(must(go, ["doc", "history", p, "--json"], dir, env)) as {
          versions?: { version: number }[];
        };
        const v = (h: typeof before) => (h.versions ?? []).map((x) => x.version);
        expect(v(after).slice(0, v(before).length)).toEqual(v(before));
        expect(must(ts, ["doc", "history", p, "--json"], dir, env)).toBe(
          must(go, ["doc", "history", p, "--json"], dir, env),
        );
        expect(withoutId(must(go, ["doc", "view", p, "--json"], dir, env))).toEqual(
          viewBefore.get(p),
        );
      }
      expect((json(must(go, ["validate", "--json"], dir, env)) as { errors: number }).errors).toBe(
        0,
      );
      // 0.34.1 itself can hard-delete in the backfilled store too.
      const g = run(
        go,
        [
          "task",
          "hard-delete",
          keeper,
          "--yes",
          "--allow-hard-delete",
          "--reason",
          "rollback test",
        ],
        dir,
        env,
      );
      expect(`${g.code} ${g.stdout}${g.stderr}`).toMatch(/^0 /);
    },
    TEST_TIMEOUT,
  );
});

// AC4: a store with no legacy Doc gets exactly 0.34.1's validate output, with and without --fix,
// in every output mode, and --fix writes nothing.
describe.skipIf(!enabled)("validate on a store without legacy Docs matches 0.34.1", () => {
  test(
    "json, plain and text output are 0.34.1's, and --fix writes nothing",
    async () => {
      const go: Side = { name: "go", cmd: [await releasedGo("0.34.1")] };
      const ts = tsSide();
      const root = realpathSync(mkdtempSync(join(tmpdir(), "knowns-no-legacy-")));
      roots.push(root);
      const dir = join(root, "proj");
      const home = join(root, "home");
      mkdirSync(dir, { recursive: true });
      mkdirSync(home);
      const env = envFor(home);
      must(go, ["init", "current", "--no-wizard", "--no-open"], dir, env);
      must(go, ["doc", "create", "Current Doc", "-d", "has an id", "-f", "guides"], dir, env);
      must(go, ["doc", "edit", "guides/current-doc", "-c", "Links @doc/missing/target."], dir, env);
      must(go, ["task", "create", "Current task", "-d", "x"], dir, env);
      const before = treeHash(join(dir, ".knowns"));
      for (const args of [
        ["validate", "--json"],
        ["validate", "--plain"],
        ["validate"],
        ["validate", "--fix", "--json"],
        ["validate", "--fix", "--plain"],
        ["validate", "--strict", "--json"],
      ]) {
        const g = run(go, args, dir, env);
        const t = run(ts, args, dir, env);
        expect({ args, code: t.code, out: t.stdout }).toEqual({
          args,
          code: g.code,
          out: g.stdout,
        });
      }
      expect(changedFiles(before, treeHash(join(dir, ".knowns")))).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});
