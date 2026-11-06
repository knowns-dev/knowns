// validate command against the Go 0.34.1 oracle, over a project seeded with every issue class.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  compareSteps,
  dispose,
  hasGoBin,
  type Project,
  type Step,
  treeContentDiff,
  writeText,
} from "./doc-harness.ts";

const cases = hasGoBin ? describe : describe.skip;
const cleanup: Project[] = [];
afterEach(() => {
  for (const p of cleanup.splice(0)) dispose(p);
});

async function expectParity(
  fixture: string,
  steps: Step[],
  setup?: (dir: string) => void,
): Promise<void> {
  const { result, goP, tsP } = await compareSteps(fixture, steps, setup);
  cleanup.push(goP, tsP);
  for (let i = 0; i < steps.length; i++) {
    const label = (steps[i] as Step).args.join(" ");
    expect({ step: label, ...(result.ts[i] as object) }).toEqual({
      step: label,
      ...(result.go[i] as object),
    });
  }
  expect(treeContentDiff(result.goTree, result.tsTree)).toEqual([]);
}

/**
 * Go lists tasks by ranging over a map, so the order of the task block in `validate` output differs
 * from run to run (and from any deterministic port). Whole-project comparisons therefore ignore
 * line order (and JSON issue order); every task is also validated alone with --entity, where the
 * order is fixed, and compared exactly.
 */
function unordered(r: { code: number; stdout: string; stderr: string }) {
  let stdout = r.stdout;
  try {
    const j = JSON.parse(stdout) as { issues: unknown[] };
    j.issues = j.issues.map((i) => JSON.stringify(i)).sort();
    stdout = JSON.stringify(j);
  } catch {
    stdout = stdout.split("\n").sort().join("\n");
  }
  return { ...r, stdout };
}

async function expectUnorderedParity(
  fixture: string,
  args: string[],
  setup?: (dir: string) => void,
): Promise<void> {
  const { result, goP, tsP } = await compareSteps(fixture, [{ args }], setup);
  cleanup.push(goP, tsP);
  expect(unordered(result.ts[0] as never)).toEqual(unordered(result.go[0] as never));
  expect(treeContentDiff(result.goTree, result.tsTree)).toEqual([]);
}

const D = "createdAt: '2026-01-01T00:00:00.000Z'\nupdatedAt: '2026-01-01T00:00:00.000Z'";

function task(id: string, front: string, body: string): string {
  return `---\nid: ${id}\n${front}\n${D}\ntimeSpent: 0\n---\n${body}\n`;
}

function taskBody(title: string, description: string, plan = "", notes = "", ac = ""): string {
  let b = `# ${title}\n\n## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\n${description}\n<!-- SECTION:DESCRIPTION:END -->\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n${ac}<!-- AC:END -->\n`;
  if (plan)
    b += `\n## Implementation Plan\n\n<!-- SECTION:PLAN:BEGIN -->\n${plan}\n<!-- SECTION:PLAN:END -->\n`;
  if (notes)
    b += `\n## Implementation Notes\n\n<!-- SECTION:NOTES:BEGIN -->\n${notes}\n<!-- SECTION:NOTES:END -->\n`;
  return b;
}

// Fixture Docs carry a stable id, as every Doc 0.26+ writes does. A Doc without one is a legacy
// Doc, for which the TS build adds a TS-only DOC_MISSING_ID issue (TSR-WR33ZF, tested in
// test/domain/validate and test/rollback), so this Go-parity fixture keeps to current Docs.
const docId = (title: string) =>
  `doc-${createHash("sha256").update(title).digest("hex").slice(0, 32)}`;

function doc(title: string, tags: string[], content: string, description = "d"): string {
  return `---\nid: ${docId(title)}\ntitle: ${title}\ndescription: ${description}\n${D}\ntags: [${tags.join(", ")}]\n---\n\n${content}\n`;
}

function memory(id: string, front: string, body: string): string {
  return `---\nid: ${id}\ntitle: Memory ${id}\n${front}\n${D}\n---\n\n${body}\n`;
}

const seed = (dir: string): void => {
  const put = (rel: string, text: string) => writeText(dir, `.knowns/${rel}`, text);

  put(
    "tasks/BAD-1.md",
    task(
      "BAD-1",
      "title: ''\nstatus: weird\npriority: extreme\nparent: NOPE\nspec: nope-spec\nlabels:\n  - a\n  - a\nfulfills:\n  - AC-1",
      taskBody(
        "",
        "See @task-NOPE and @doc/missing and @memory/zzz and @decision/zzz and @template/zzz and @doc/architecture{bogus} and @task/BAD-2{blocked-by}.",
        "Plan @doc/missing2",
        "Notes @memory-qq",
      ),
    ),
  );
  put(
    "tasks/BAD-2.md",
    task("BAD-2", "title: Two\nstatus: todo\npriority: low\nparent: BAD-3", taskBody("Two", "x")),
  );
  put(
    "tasks/BAD-3.md",
    task(
      "BAD-3",
      "title: Three\nstatus: todo\npriority: medium\nparent: BAD-2",
      taskBody("Three", "y"),
    ),
  );
  put(
    "tasks/BAD-4.md",
    task("BAD-4", "title: Four\nstatus: ''\npriority: ''", taskBody("Four", "z")),
  );
  put(
    "tasks/DONE-1.md",
    task(
      "DONE-1",
      "title: Done one\nstatus: done\npriority: high",
      taskBody("Done one", "d", "", "", "1. [x] first\n2. [ ] second\n3. [ ] third\n"),
    ),
  );

  put(
    "docs/specs/good.md",
    doc(
      "Good spec",
      ["spec"],
      "## Locked Decisions\n\n- D1: first rule\n- D2: second rule\n\n## System Decision Impact\n\n- Impact: none. Nothing changes.\n\n## Other\n\ntext",
    ),
  );
  put("docs/specs/legacy.md", doc("Legacy spec", ["spec"], "# Legacy\n\nno decisions here"));
  put(
    "docs/specs/dup.md",
    doc(
      "Dup spec",
      ["Spec"],
      "## Locked Decisions\n\n- D1: a\n- D1: b\n- d2: c\n\n## System Decision Impact\n\n- Impact: bogus\n",
    ),
  );
  put(
    "docs/specs/empty.md",
    doc(
      "Empty spec",
      ["spec"],
      "## Locked Decisions\n\nnothing\n\n## System Decision Impact\n\n- Impact: draft new\n",
    ),
  );
  put(
    "docs/specs/optin.md",
    doc(
      "Opt-in spec",
      ["spec"],
      "## Locked Decisions\n\n- D1: x\n- D2: y\n- D3: z\n\n## System Decision Impact\n\n- Impact: existing decision foo\n",
    ),
  );
  put(
    "docs/refs.md",
    doc(
      "",
      [],
      "Refs @doc/nowhere @doc/specs/good#x{implements} @task-GHOST @memory/nothing @decision/none @template/none @doc/specs/good{nope}\n```\n@doc/in-fence\n```",
      "",
    ),
  );
  put("docs/empty.md", `---\nid: ${docId("Empty")}\ntitle: Empty\n${D}\ntags: []\n---\n`);
  put("docs/broken.md", "---\ntitle: [unclosed\n---\nbody\n");

  put(
    "tasks/SDD-1.md",
    task(
      "SDD-1",
      "title: Sdd one\nstatus: in-progress\npriority: high\nspec: specs/optin",
      taskBody("Sdd one", "d", "", "Spec Decision Compliance: D1=pass, D2=conflict: we cannot"),
    ),
  );
  put(
    "tasks/SDD-2.md",
    task(
      "SDD-2",
      "title: Sdd two\nstatus: in-review\npriority: high\nspec: specs/optin",
      taskBody("Sdd two", "d", "", "Spec Decision Compliance: D1=pass"),
    ),
  );
  put(
    "tasks/SDD-3.md",
    task(
      "SDD-3",
      "title: Sdd three\nstatus: done\npriority: high\nspec: specs/optin",
      taskBody(
        "Sdd three",
        "d",
        "",
        "Spec Decision Compliance: d1=PASS; D2=pass, D3=pass\nSpec Decision Compliance: D1=pass, D2=pass, D3=pass",
      ),
    ),
  );
  put(
    "tasks/SDD-4.md",
    task(
      "SDD-4",
      "title: Sdd four\nstatus: todo\npriority: high\nspec: specs/optin",
      taskBody("Sdd four", "d"),
    ),
  );
  put(
    "tasks/SDD-5.md",
    task(
      "SDD-5",
      "title: Sdd five\nstatus: in-progress\npriority: high\nspec: specs/legacy",
      taskBody("Sdd five", "d", "", "n"),
    ),
  );
  put(
    "tasks/SDD-6.md",
    task(
      "SDD-6",
      "title: Sdd six\nstatus: in-progress\npriority: high\nspec: specs/dup",
      taskBody("Sdd six", "d"),
    ),
  );
  put(
    "tasks/SDD-7.md",
    task(
      "SDD-7",
      "title: Sdd seven\nstatus: in-progress\npriority: high\nspec: specs/empty",
      taskBody("Sdd seven", "d"),
    ),
  );
  put(
    "tasks/SDD-8.md",
    task(
      "SDD-8",
      "title: Sdd eight\nstatus: in-progress\npriority: high\nspec: specs/broken-spec",
      taskBody("Sdd eight", "d"),
    ),
  );

  // A global memory (the sandbox HOME is the project's sibling): validated only with
  // --include-global, but resolvable from project entities either way.
  writeText(
    dir,
    "../home/.knowns/memory/memory-g1.md",
    memory("g1", "layer: global\ncategory: pattern\nstatus: active", "Global body @doc/not-here"),
  );
  put("docs/uses-global.md", doc("Uses global", [], "refs @memory/g1 and @memory/g2"));
  const old = "2020-01-01T00:00:00.000Z";
  put(
    "memory/memory-ttl.md",
    memory(
      "ttl",
      `layer: project\ncategory: pattern\nstatus: active\nconfidence: high\nlastVerified: '${old}'\nttlDays: 10\nsources:\n  - '@task/BAD-2'\n  - '@doc/missing'\n  - '@memory/zzz'\n  - '@decision/20261103-1337-adopt-a-monorepo'\n  - '@decision/gone'\n  - plain text\n  - '@task/BAD-9.'`,
      "Body @doc/gone",
    ),
  );
  put(
    "memory/memory-bad.md",
    memory("bad", `layer: weird\ncategory: pattern\nstatus: nonsense\nconfidence: sure`, "x"),
  );
  put("memory/memory-nostatus.md", memory("nostatus", `layer: project\ncategory: pattern`, ""));
  put(
    "memory/memory-old.md",
    `---\nid: old\ntitle: Old proposal\nlayer: project\ncategory: pattern\nstatus: proposed\nconfidence: low\ncreatedAt: '${old}'\nupdatedAt: '${old}'\nsources:\n  - '@task/BAD-2'\n---\n\nOld.\n`,
  );
  put(
    "memory/memory-merged.md",
    memory(
      "merged",
      `layer: project\ncategory: pattern\nstatus: merged\nconfidence: low\nlastVerified: '2099-01-01T00:00:00Z'\nttlDays: 1\nsources: ['@task/BAD-2']`,
      "m",
    ),
  );
  put(
    "memory/memory-rejected.md",
    memory(
      "rejected",
      `layer: project\ncategory: pattern\nstatus: rejected\nconfidence: low\nlastVerified: '2099-01-01T00:00:00Z'\nttlDays: 1\nsources: ['@task/BAD-2']`,
      "r",
    ),
  );
  put(
    "memory/memory-long.md",
    memory(
      "long",
      `layer: project\ncategory: pattern\nstatus: active\nconfidence: low\nlastVerified: '2099-01-01T00:00:00Z'\nttlDays: 1\nsources: ['@task/BAD-2']`,
      "é".repeat(12001),
    ),
  );
};

const seedGlobal = (dir: string): void => {
  seed(dir);
};

cases("validate matches Go", () => {
  const runs: string[][] = [
    ["validate"],
    ["validate", "--plain"],
    ["validate", "--json"],
    ["validate", "--strict"],
    ["validate", "--strict", "--plain"],
    ["validate", "--strict", "--json"],
    ["validate", "--fix", "--plain"],
    ["validate", "--scope", "tasks", "--plain"],
    ["validate", "--scope", "docs", "--plain"],
    ["validate", "--scope", "templates", "--plain"],
    ["validate", "--scope", "memory", "--plain"],
    ["validate", "--scope", "sdd", "--plain"],
    ["validate", "--scope", "sdd", "--json"],
    ["validate", "--scope", "sdd", "--strict", "--plain"],
    ["validate", "--scope", "nonsense", "--plain"],
    ["validate", "--entity", "BAD-1", "--plain"],
    ["validate", "--entity", "specs/good", "--scope", "sdd", "--plain"],
    ["validate", "--entity", "specs/dup", "--scope", "sdd", "--plain"],
    ["validate", "--entity", "ttl", "--scope", "memory", "--plain"],
    ["validate", "--entity", "broken", "--scope", "templates", "--plain"],
    ["validate", "--entity", "nothing-matches", "--plain"],
    ["validate", "--scope", "tasks", "--entity", "SDD-2", "--json"],
    ["validate", "--include-global", "--plain"],
    ["validate", "--include-global", "--scope", "memory", "--plain"],
    ["validate", "--help"],
    ["validate", "--scope"],
    ["validate", "extra-arg"],
    ["validate", "--bogus"],
  ];
  for (const args of runs) {
    test(args.join(" "), async () => {
      if (args.includes("--entity") || args.includes("--help")) {
        await expectParity("full", [{ args }], seedGlobal);
      } else {
        await expectUnorderedParity("full", args, seedGlobal);
      }
    });
  }

  const taskIds = [
    "BAD-1",
    "BAD-2",
    "BAD-3",
    "BAD-4",
    "DONE-1",
    "FX-3VT2SR",
    "SDD-1",
    "SDD-2",
    "SDD-3",
    "SDD-4",
    "SDD-5",
    "SDD-6",
    "SDD-7",
    "SDD-8",
  ];
  for (const id of taskIds) {
    for (const scope of ["tasks", "sdd"]) {
      test(`entity ${id} scope ${scope}`, async () => {
        await expectParity(
          "full",
          [
            { args: ["validate", "--scope", scope, "--entity", id, "--plain"] },
            { args: ["validate", "--scope", scope, "--entity", id, "--json"] },
            { args: ["validate", "--scope", scope, "--entity", id, "--strict"] },
          ],
          seedGlobal,
        );
      });
    }
  }
  for (const id of [
    "architecture",
    "refs",
    "empty",
    "broken",
    "specs/good",
    "specs/legacy",
    "specs/dup",
    "specs/empty",
    "specs/optin",
    "guides/setup-guide",
  ]) {
    test(`entity doc ${id}`, async () => {
      await expectParity(
        "full",
        [
          { args: ["validate", "--scope", "docs", "--entity", id, "--plain"] },
          { args: ["validate", "--scope", "sdd", "--entity", id, "--plain"] },
        ],
        seedGlobal,
      );
    });
  }
  for (const id of [
    "ttl",
    "bad",
    "nostatus",
    "old",
    "merged",
    "rejected",
    "long",
    "kunv9q",
    "rrvcia",
  ]) {
    test(`entity memory ${id}`, async () => {
      await expectParity(
        "full",
        [{ args: ["validate", "--scope", "memory", "--entity", id, "--plain"] }],
        seedGlobal,
      );
    });
  }

  test("validate on the untouched fixtures", async () => {
    for (const fixture of ["full", "empty", "active-timer"]) {
      for (const args of [
        ["validate"],
        ["validate", "--plain"],
        ["validate", "--json"],
        ["validate", "--scope", "sdd", "--plain"],
        ["validate", "--include-global", "--plain"],
      ]) {
        await expectUnorderedParity(fixture, args);
      }
    }
  });

  test("outside a project", async () => {
    await expectParity("", [{ args: ["validate"] }]);
  });

  test("validate after doc operations", async () => {
    await expectParity("full", [
      { args: ["doc", "create", "Linky", "-c", "see @doc/ghost and @doc/architecture"] },
      { args: ["validate", "--scope", "docs", "--plain"] },
      { args: ["doc", "edit", "architecture", "--path", "arch-moved"] },
      { args: ["validate", "--plain"] },
      { args: ["doc", "delete", "arch-moved", "--force"] },
      { args: ["validate", "--plain"] },
    ]);
  });
});
