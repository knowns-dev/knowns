// The CLI reference generator (scripts/gen-cli-docs.ts, src/cli/docs/) against tools/gendocs, the
// Go generator it replaces. The Go tree is 0.34.1 (D2), so its pages are the baseline; the TS tree
// differs from it by exactly the spec deltas below, removed with literal patterns so anything else
// that differs still fails:
//   D8   `knowns import` and its subcommands are removed stubs (their pages say so).
//   D13  `task assignees` and `task list --unassigned`; those pages are compared byte for byte with
//        the reference PR #156 ships (head 2b3f88d), checked in under pr156/.
//   D14  `knowns qdrant setup`.
import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "../../../src/cli/core/command.ts";
import {
  isSourceFile,
  lintDocs,
  lintLine,
  lintPaths,
  resolvePath,
} from "../../../src/cli/docs/lint.ts";
import { renderPage, renderTree } from "../../../src/cli/docs/render.ts";
import { loadCommandTree } from "../../../src/cli/docs/tree.ts";

const CLI = resolve(import.meta.dir, "../../..");
const REPO = resolve(CLI, "..");
const SCRIPT = join(CLI, "scripts/gen-cli-docs.ts");
const PR156 = join(import.meta.dir, "pr156");

function gen(...args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: CLI, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function readPages(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(dir).sort()) {
    if (name.endsWith(".md")) out.set(name, readFileSync(join(dir, name), "utf8"));
  }
  return out;
}

const D13_PAGES = ["knowns_task_assignees.md", "knowns_task.md", "knowns_task_list.md"];
const D14_SETUP_ROW =
  "- [`knowns qdrant setup`](knowns_qdrant_setup.md) — Detect and set up a Qdrant for semantic search on this machine\n";
const D8_ROOT_ROW: [string, string] = [
  "- [`knowns import`](knowns_import.md) — Removed (imported content stays readable)\n",
  "- [`knowns import`](knowns_import.md) — Manage imported Knowns packages\n",
];
const isD8Page = (name: string): boolean => /^knowns_import(_[a-z]+)?\.md$/.test(name);

/** The TS pages with the D8, D13 and D14 deltas taken out, comparable to the 0.34.1 pages. */
function withoutSpecDeltas(ts: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, body] of ts) {
    if (
      isD8Page(name) ||
      name === "knowns_task_assignees.md" ||
      name === "knowns_qdrant_setup.md"
    ) {
      continue;
    }
    let b = body;
    if (name === "knowns.md") b = b.replace(D8_ROOT_ROW[0], D8_ROOT_ROW[1]);
    if (name === "knowns_qdrant.md") b = b.replace(D14_SETUP_ROW, "");
    if (name === "knowns_task.md") {
      b = b.replace(
        "- [`knowns task assignees`](knowns_task_assignees.md) — Count tasks per assignee\n",
        "",
      );
    }
    if (name === "knowns_task_list.md") {
      b = b
        .replace("  # Work nobody has picked up yet\n  knowns task list --unassigned\n\n", "")
        .replace("| `--unassigned` | `bool` | — | Only tasks with no assignee |\n", "");
    }
    out.set(name, b);
  }
  return out;
}

let tsPages: Map<string, string>;
beforeAll(async () => {
  tsPages = renderTree(await loadCommandTree());
});

// --- the real tree -------------------------------------------------------------------------------

describe("CLI reference from the TS command tree", () => {
  test("D13 pages equal the reference PR #156 ships", () => {
    for (const name of D13_PAGES) {
      expect({ name, body: tsPages.get(name) }).toEqual({
        name,
        body: readFileSync(join(PR156, `${name}.golden`), "utf8"),
      });
    }
  });

  test("D8 import pages document the removal; D14 adds the qdrant setup page", () => {
    for (const name of ["knowns_import.md", "knowns_import_add.md", "knowns_import_sync.md"]) {
      expect(tsPages.get(name)).toContain("were removed");
    }
    expect(tsPages.get("knowns_qdrant_setup.md")).toStartWith("# knowns qdrant setup\n");
    expect(tsPages.get("knowns_qdrant.md")).toContain(D14_SETUP_ROW);
  });

  test("help and the execute-time completion command get no page, as in the Go tree", () => {
    expect([...tsPages.keys()].filter((n) => /help|completion/.test(n))).toEqual([]);
    expect(tsPages.get("knowns.md")).not.toContain("knowns completion");
  });

  test("--check passes on a fresh copy and reports missing, stale and changed pages", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-docs-"));
    try {
      expect(gen("--out", dir).status).toBe(0);
      const ok = gen("--check", "--out", dir);
      expect(ok.status).toBe(0);
      expect(ok.stdout).toBe(`CLI reference is up to date (${tsPages.size} pages).\n`);

      rmSync(join(dir, "knowns_task_assignees.md"));
      writeFileSync(join(dir, "knowns_model.md"), "# knowns model\n");
      writeFileSync(join(dir, "knowns_task_list.md"), "edited by hand\n");
      mkdirSync(join(dir, "sub"));
      const bad = gen("--check", "--out", dir);
      expect(bad.status).toBe(1);
      expect(bad.stdout).toBe("");
      expect(bad.stderr).toBe(
        "gen-cli-docs: CLI reference is out of date. Run: make cli-docs\n" +
          "\n  missing (command exists, page does not):\n    knowns_task_assignees.md\n" +
          "\n  stale (page exists, command does not):\n    knowns_model.md\n" +
          "\n  changed (flags or help text differ):\n    knowns_task_list.md\n\n",
      );

      // Writing drops the stale page and restores the others.
      expect(gen("--out", dir).status).toBe(0);
      expect(gen("--check", "--out", dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- against tools/gendocs (Go 0.34.1) -----------------------------------------------------------

const hasGo = Bun.which("go") !== null;
let goDir: string | undefined;
let goBin: string | undefined;

// A cold `go build` can outlast bun's 5s test timeout, so build at load time, outside any test.
if (hasGo) {
  const dir = mkdtempSync(join(tmpdir(), "gendocs-oracle-"));
  const exe = join(dir, process.platform === "win32" ? "gendocs.exe" : "gendocs");
  const b = spawnSync("go", ["build", "-o", exe, "./tools/gendocs"], {
    cwd: REPO,
    encoding: "utf8",
  });
  if (b.status !== 0) throw new Error(`go build ./tools/gendocs failed: ${b.stderr}`);
  goBin = exe;
  goDir = join(dir, "pages");
  const r = spawnSync(exe, ["--out", goDir], { cwd: REPO, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`gendocs failed: ${r.stderr}`);
}

describe.skipIf(!hasGo)("parity with tools/gendocs", () => {
  test("same file set and content, apart from the D8, D13 and D14 deltas", () => {
    const go = readPages(goDir as string);
    const goComparable = new Map([...go].filter(([name]) => !isD8Page(name)));
    expect(Object.fromEntries(withoutSpecDeltas(tsPages))).toEqual(
      Object.fromEntries(goComparable),
    );
    // The D8 pages are the same set of commands, now documented as removed.
    expect([...go.keys()].filter(isD8Page)).toEqual([...tsPages.keys()].filter(isD8Page).sort());
  });

  test("--lint output and exit code equal gendocs --lint", () => {
    const go = spawnSync(goBin as string, ["--lint"], { cwd: REPO, encoding: "utf8" });
    const ts = gen("--lint");
    expect({ status: ts.status, stdout: ts.stdout, stderr: ts.stderr }).toEqual({
      status: go.status ?? -1,
      stdout: go.stdout,
      stderr: go.stderr,
    });
    expect(ts.stdout).toMatch(/^Docs are consistent with the command tree \(\d+ invocations/);
  });
});

// --- lint and render units (tools/gendocs/lint_test.go, ported) ---------------------------------

/** A small tree, so these cases do not depend on the real CLI surface. */
function tree(): Command {
  const run = (): void => undefined;
  const root = new Command({ use: "knowns" });
  root.persistentFlags().define("bool", "plain", "", "Plain text output", false);
  const setup = new Command({ use: "setup", short: "Configure integrations", run });
  setup.flags().define("bool", "global", "", "Install to user-level paths", false);
  const init = new Command({ use: "init", short: "Initialize", run });
  init.flags().define("bool", "force", "", "Force", false);
  const memory = new Command({ use: "memory", short: "Manage memory" });
  const create = new Command({ use: "create <title>", short: "Create a memory", run });
  create.flags().define("string", "category", "", "Memory category", "");
  memory.addCommand(create);
  root.addCommand(setup, init, memory);
  return root;
}

const findings = (root: Command, line: string): string[] =>
  lintLine(root, line).filter((f) => f !== "");

describe("lint", () => {
  test.each([
    [
      "flag belongs to the second command on the line",
      "`knowns init` creates the store; integrations use `knowns setup <target> --global`.",
      [],
    ],
    ["flag genuinely missing", "knowns init --global", ["knowns init does not accept --global"]],
    ["subcommand flag resolves through the path", 'knowns memory create "x" --category p', []],
    [
      "flag on the group, not the subcommand",
      "knowns memory --category pattern",
      ["knowns memory does not accept --category"],
    ],
    ["placeholder stops path resolution", "knowns setup <target> --global", []],
    ["unknown command yields no finding", "knowns notacommand --whatever", []],
    ["the lazily registered help flag is accepted", "knowns init --help", []],
    ["a persistent root flag is inherited", "knowns memory create x --plain", []],
    [
      "unfenced source line",
      `fmt.Println("Use 'knowns init --global' to set up")`,
      ["knowns init does not accept --global"],
    ],
  ])("%s", (_name, line, want) => {
    expect(findings(tree(), line)).toEqual(want);
  });

  test("source files are scanned, markdown and the generated reference are not", () => {
    for (const p of [
      "internal/cli/agents.go",
      "ui/src/pages/WelcomePage.tsx",
      "cmd/knowns/main.go",
    ]) {
      expect({ p, scanned: isSourceFile(p) }).toEqual({ p, scanned: true });
    }
    for (const p of ["README.md", "docs/en/cli-reference/knowns_task.md", "ui/src/styles.css"]) {
      expect({ p, scanned: isSourceFile(p) }).toEqual({ p, scanned: false });
    }
  });

  test("resolvePath stops at the first word that is not a subcommand", () => {
    expect(resolvePath(tree(), ["memory", "create", "x"])?.[1]).toEqual(["memory", "create"]);
    expect(resolvePath(tree(), ["nope"])).toBeUndefined();
  });

  test("a planted bad flag and a missing file fail; prose and the reference are skipped", () => {
    const repo = mkdtempSync(join(tmpdir(), "cli-docs-lint-"));
    try {
      mkdirSync(join(repo, "docs/en/cli-reference"), { recursive: true });
      writeFileSync(
        join(repo, "docs/en/guide.md"),
        [
          "Prose may say `knowns init --nope` freely.",
          "```bash",
          "knowns init --force",
          "knowns init --nope",
          "```",
          "See `cli/src/missing.ts` and `README.md`.",
          "",
        ].join("\n"),
      );
      writeFileSync(join(repo, "docs/en/cli-reference/x.md"), "```\nknowns init --nope\n```\n");
      expect(lintDocs(tree(), repo)).toEqual({
        findings: [
          { file: "docs/en/guide.md", line: "4", detail: "knowns init does not accept --nope" },
        ],
        checked: 2,
      });
      expect(lintPaths(repo).findings).toEqual([
        { file: "docs/en/guide.md", line: "6", token: "cli/src/missing.ts" },
      ]);
      writeFileSync(join(repo, "docs/allowed-missing-paths.txt"), "# reason\ncli/src/missing.ts\n");
      expect(lintPaths(repo)).toMatchObject({ findings: [], checked: 0 });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("the real tree knows the D13 flag and the D13 command", async () => {
    const root = await loadCommandTree();
    expect(findings(root, "knowns task list --unassigned --status todo")).toEqual([]);
    expect(findings(root, "knowns task assignees --unassigned --json")).toEqual([]);
    expect(findings(root, "knowns task list --unasigned")).toEqual([
      "knowns task list does not accept --unasigned",
    ]);
  });
});

describe("render", () => {
  test("a page never embeds the version, and says it is generated", () => {
    const root = tree();
    root.version = "9.9.9";
    const page = renderPage(root);
    expect(page).not.toContain("9.9.9");
    expect(page).toContain("Do not edit by hand");
  });

  test("hidden commands get no page; nested visible ones do", () => {
    const root = tree();
    root.addCommand(new Command({ use: "__daemon", hidden: true, run: () => undefined }));
    const pages = renderTree(root);
    expect(pages.has("knowns___daemon.md")).toBe(false);
    expect(pages.has("knowns_memory_create.md")).toBe(true);
  });

  test("a | in a flag description is escaped so the table holds", () => {
    const root = tree();
    root.flags().define("string", "mode", "m", "one | two", "one");
    expect(renderPage(root)).toContain("| `-m, --mode` | `string` | `one` | one \\| two |\n");
  });
});
