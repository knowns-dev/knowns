// doc command tree against the Go 0.34.1 oracle: stdout, stderr, exit code and the on-disk tree.
// Needs KNOWNS_GO_BIN; the comparisons skip without it. Normalisation is described in doc-harness.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareSteps,
  dispose,
  hasGoBin,
  makeProject,
  type Project,
  runTsIn,
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

const one = (...args: string[]): Step[] => [{ args }];

cases("doc read commands match Go", () => {
  const reads: string[][] = [
    ["doc", "list"],
    ["doc", "list", "--plain"],
    ["doc", "list", "--json"],
    ["doc", "list", "--tag", "guide"],
    ["doc", "list", "--tag", "nope"],
    ["doc", "list", "--tag", "nope", "--json"],
    ["doc", "list", "--tag", "nope", "--plain"],
    ["doc", "list", "--plain", "--page", "1"],
    ["doc", "list", "--plain", "--page", "1", "--page-size", "2"],
    ["doc", "list", "--plain", "--page", "9"],
    ["doc", "list", "--page", "2"],
    ["doc", "architecture"],
    ["doc", "architecture", "--plain"],
    ["doc", "architecture", "--json"],
    ["doc", "view", "architecture"],
    ["doc", "view", "architecture", "--plain"],
    ["doc", "view", "guides/setup-guide", "--plain"],
    ["doc", "view", "guides/deep/er/nested-doc"],
    ["doc", "view", "architecture.md", "--json"],
    ["doc", "view", "nope"],
    ["doc", "view", "nope", "--json"],
    ["doc", "nope"],
    ["doc", "view"],
    ["doc", "view", "a", "b"],
    ["doc", "architecture", "--toc"],
    ["doc", "architecture", "--toc", "--plain"],
    ["doc", "guides/setup-guide", "--toc"],
    ["doc", "guides/setup-guide", "--toc", "--plain"],
    ["doc", "architecture", "--info"],
    ["doc", "architecture", "--info", "--plain"],
    ["doc", "architecture", "--section", "1"],
    ["doc", "guides/setup-guide", "--section", "Install"],
    ["doc", "guides/setup-guide", "--section", "config"],
    ["doc", "guides/setup-guide", "--section", "2"],
    ["doc", "guides/setup-guide", "--section", "9"],
    ["doc", "architecture", "--section", "nope"],
    ["doc", "architecture", "--line", "1"],
    ["doc", "guides/setup-guide", "--line", "2-4"],
    ["doc", "guides/setup-guide", "--line", "3-4", "--plain"],
    ["doc", "guides/setup-guide", "--line", "2-999", "--plain"],
    ["doc", "guides/setup-guide", "--line", "999-1000"],
    ["doc", "guides/setup-guide", "--line", "999"],
    ["doc", "guides/setup-guide", "--line", "0"],
    ["doc", "guides/setup-guide", "--line", "abc"],
    ["doc", "guides/setup-guide", "--line", "5-3"],
    ["doc", "architecture", "--smart"],
    ["doc", "architecture", "--smart", "--plain"],
    ["doc", "view", "architecture", "--smart", "--toc"],
    ["doc", "view", "architecture", "--json", "--toc"],
    ["doc", "view", "architecture", "--info", "--toc", "--plain"],
    ["doc", "view", "architecture", "--section", "1", "--line", "1"],
    ["doc", "--help"],
    ["doc", "list", "--help"],
    ["doc", "view", "--help"],
    ["doc", "create", "--help"],
    ["doc", "edit", "--help"],
    ["doc", "delete", "--help"],
    ["doc", "hard-delete", "--help"],
    ["doc", "history", "--help"],
    ["doc", "history", "architecture"],
    ["doc", "history", "architecture", "--plain"],
    ["doc", "history", "architecture", "--json"],
    ["doc", "history", "architecture", "--metadata"],
    ["doc", "history", "architecture", "--metadata", "--json"],
    ["doc", "history", "architecture", "--limit", "1", "--plain"],
    ["doc", "history", "architecture", "--offset", "1"],
    ["doc", "history", "architecture", "--revision", "v1"],
    ["doc", "history", "architecture", "--revision", "1", "--plain"],
    ["doc", "history", "architecture", "--revision", "v1", "--json"],
    ["doc", "history", "architecture", "--revision", "v99"],
    ["doc", "history", "nope"],
    ["doc", "history", "nope", "--json"],
    ["doc", "history", "guides/setup-guide"],
    ["doc", "history", "guides/setup-guide", "--plain"],
    ["doc", "history", "guides/setup-guide", "--json"],
    ["doc", "history", "guides/setup-guide", "--plain", "--page", "1", "--page-size", "10"],
    ["doc", "history", "patterns/controllers/controller-pattern", "--plain"],
    ["doc", "bogus-flag", "--nope"],
    ["doc", "list", "--bogus"],
  ];
  for (const args of reads) {
    test(args.join(" "), async () => {
      await expectParity("full", one(...args));
    });
  }

  test("empty project", async () => {
    for (const args of [
      ["doc", "list"],
      ["doc", "list", "--plain"],
      ["doc", "list", "--json"],
      ["doc", "view", "x"],
    ]) {
      await expectParity("empty", one(...args));
    }
  });

  test("outside a project", async () => {
    await expectParity("", one("doc", "list"));
    await expectParity("", one("doc", "x"));
  });

  test("COLUMNS narrows the styled table", async () => {
    const { result, goP, tsP } = await compareSteps("full", one("doc", "list"));
    cleanup.push(goP, tsP);
    expect(result.ts[0]).toEqual(result.go[0] as never);
  });
});

cases("doc write commands match Go", () => {
  const writes: Array<[string, string[][]]> = [
    ["create plain", [["doc", "create", "Hello World"]]],
    [
      "create with every flag",
      [
        [
          "doc",
          "create",
          "Hello World",
          "-d",
          "A description",
          "-t",
          "a",
          "-t",
          "b",
          "-f",
          "patterns/sub",
          "-c",
          "Body text\n\nsecond paragraph",
        ],
      ],
    ],
    ["create joins args", [["doc", "create", "Multi", "Word", "Title"]]],
    ["create unicode title", [["doc", "create", "Tài liệu Việt Nam 2026"]]],
    ["create slug of symbols", [["doc", "create", "  --Weird!!  Title__  "]]],
    [
      "create twice conflicts",
      [
        ["doc", "create", "Dup"],
        ["doc", "create", "Dup"],
      ],
    ],
    ["create over existing path", [["doc", "create", "Architecture"]]],
    ["create without title", [["doc", "create"]]],
    ["create escaping folder", [["doc", "create", "Escape", "-f", "../outside", "-c", "x"]]],
    ["create absolute folder", [["doc", "create", "Abs", "-f", "/abs", "-c", "x"]]],
    ["create empty slug", [["doc", "create", "!!!"]]],
    [
      "create then view",
      [
        ["doc", "create", "Round Trip", "-c", "# H\n\nbody"],
        ["doc", "round-trip", "--plain"],
        ["doc", "history", "round-trip", "--plain"],
      ],
    ],
    ["edit title", [["doc", "edit", "architecture", "-t", "New Title"]]],
    ["edit description", [["doc", "edit", "architecture", "-d", "New desc"]]],
    ["edit clear description", [["doc", "edit", "architecture", "-d", ""]]],
    ["edit tags", [["doc", "edit", "architecture", "--tags", "x, y ,,z"]]],
    ["edit clear tags", [["doc", "edit", "architecture", "--tags", ""]]],
    ["edit content", [["doc", "edit", "architecture", "-c", "Replaced body"]]],
    ["edit clear content", [["doc", "edit", "architecture", "-c", ""]]],
    ["edit append", [["doc", "edit", "architecture", "-a", "appended line"]]],
    [
      "edit append with trailing newline",
      [
        ["doc", "edit", "architecture", "-c", "line\n"],
        ["doc", "edit", "architecture", "-a", "tail"],
      ],
    ],
    [
      "edit append to empty",
      [
        ["doc", "edit", "architecture", "-c", ""],
        ["doc", "edit", "architecture", "-a", "only"],
      ],
    ],
    ["edit content and append", [["doc", "edit", "architecture", "-c", "A", "-a", "B"]]],
    [
      "edit section by number",
      [["doc", "edit", "guides/setup-guide", "--section", "2", "-c", "Replaced install body"]],
    ],
    [
      "edit section by title",
      [["doc", "edit", "guides/setup-guide", "--section", "configure", "-c", "Cfg body"]],
    ],
    [
      "edit missing section",
      [["doc", "edit", "guides/setup-guide", "--section", "nope", "-c", "x"]],
    ],
    [
      "edit section without content",
      [["doc", "edit", "guides/setup-guide", "--section", "2", "-d", "d"]],
    ],
    ["edit rename", [["doc", "edit", "architecture", "--path", "arch/renamed"]]],
    [
      "edit rename with .md and slashes",
      [["doc", "edit", "architecture", "--path", "/arch/renamed2.md/"]],
    ],
    [
      "edit rename onto existing",
      [["doc", "edit", "architecture", "--path", "guides/setup-guide"]],
    ],
    ["edit rename to same path", [["doc", "edit", "architecture", "--path", "architecture"]]],
    [
      "edit rename and edit",
      [["doc", "edit", "architecture", "--path", "moved", "-t", "Moved", "-a", "more"]],
    ],
    ["edit missing", [["doc", "edit", "nope", "-c", "x"]]],
    [
      "edit stale hash",
      [["doc", "edit", "architecture", "--expected-hash", "deadbeef", "-c", "x"]],
    ],
    ["edit no changes", [["doc", "edit", "architecture"]]],
    [
      "edit twice then history",
      [
        ["doc", "edit", "architecture", "-c", "one"],
        ["doc", "edit", "architecture", "-a", "two"],
        ["doc", "history", "architecture", "--plain"],
        ["doc", "history", "architecture", "--json"],
      ],
    ],
    [
      "rename then history of both paths",
      [
        ["doc", "edit", "architecture", "--path", "arch2"],
        ["doc", "history", "arch2", "--plain"],
        ["doc", "history", "architecture", "--plain"],
        ["doc", "history", "arch2", "--metadata", "--json"],
      ],
    ],
    ["delete dry run", [["doc", "delete", "architecture", "--dry-run"]]],
    ["delete force", [["doc", "delete", "architecture", "--force"]]],
    [
      "delete force then view and history",
      [
        ["doc", "delete", "architecture", "--force"],
        ["doc", "architecture"],
        ["doc", "history", "architecture", "--plain"],
        ["doc", "list"],
      ],
    ],
    ["delete missing", [["doc", "delete", "nope", "--force"]]],
    [
      "delete stale hash",
      [["doc", "delete", "architecture", "--force", "--expected-hash", "deadbeef"]],
    ],
    ["delete without path", [["doc", "delete"]]],
    ["hard-delete without capability", [["doc", "hard-delete", "architecture"]]],
    ["hard-delete without yes", [["doc", "hard-delete", "architecture", "--allow-hard-delete"]]],
    [
      "hard-delete without reason",
      [["doc", "hard-delete", "architecture", "--allow-hard-delete", "--yes"]],
    ],
    [
      "hard-delete blank reason",
      [["doc", "hard-delete", "architecture", "--allow-hard-delete", "--yes", "--reason", "   "]],
    ],
    [
      "hard-delete missing doc",
      [["doc", "hard-delete", "nope", "--allow-hard-delete", "--yes", "--reason", "r"]],
    ],
    [
      "hard-delete stale hash",
      [
        [
          "doc",
          "hard-delete",
          "architecture",
          "--allow-hard-delete",
          "--yes",
          "--reason",
          "r",
          "--expected-hash",
          "deadbeef",
        ],
      ],
    ],
  ];
  for (const [name, seq] of writes) {
    test(name, async () => {
      await expectParity(
        "full",
        seq.map((args) => ({ args })),
      );
    });
  }

  test("create in an empty project", async () => {
    await expectParity("empty", [
      { args: ["doc", "create", "First"] },
      { args: ["doc", "list", "--plain"] },
      { args: ["doc", "list", "--json"] },
    ]);
  });
});

cases("doc delete confirmation reads stdin", () => {
  const prompts: Array<[string, string]> = [
    ["yes", "yes\n"],
    ["y", "y\n"],
    ["no", "n\n"],
    ["empty line", "\n"],
    ["eof", ""],
    ["uppercase", "Y\n"],
    ["extra tokens", "y please\n"],
    ["padded", "  yes  \n"],
  ];
  for (const [name, stdin] of prompts) {
    test(name, async () => {
      await expectParity("full", [
        { args: ["doc", "delete", "architecture"], stdin },
        { args: ["doc", "list", "--plain"] },
      ]);
    });
  }
});

cases("doc rename rewrites references through rewriteDocPath", () => {
  const seed = (dir: string): void => {
    writeText(
      dir,
      ".knowns/docs/guides/links.md",
      [
        "---",
        "title: Links",
        "description: refs",
        "createdAt: '2026-11-03T13:37:36.556Z'",
        "updatedAt: '2026-11-03T13:37:36.854Z'",
        "tags: []",
        "---",
        "",
        "See @doc/architecture, @doc/architecture#overview{implements}, @doc/architecture:10-20{related}.",
        "Also @doc/architecture.md and @doc/architecture2 and `@doc/architecture` in prose.",
        "",
        "```",
        "@doc/architecture stays in a fence",
        "```",
        "",
        "Tail @doc/architecture:3 and @doc/architecture{depends}.",
      ].join("\n"),
    );
    const task = readFileSync(join(dir, ".knowns/tasks/FX-19XJKQ.md"), "utf8")
      .replace("title: Prod is down", "title: Prod is down\nspec: architecture")
      .replace(
        "<!-- SECTION:DESCRIPTION:BEGIN -->\n",
        "<!-- SECTION:DESCRIPTION:BEGIN -->\nBlocked on @doc/architecture#design and @doc/guides/setup-guide.\n",
      );
    writeText(dir, ".knowns/tasks/FX-19XJKQ.md", task);
    const mem = readFileSync(join(dir, ".knowns/memory/memory-kunv9q.md"), "utf8").replace(
      "Keep stores small.",
      "Keep stores small, see @doc/architecture{follows}.",
    );
    writeText(dir, ".knowns/memory/memory-kunv9q.md", mem);
  };

  test("rename rewrites docs, tasks, memories and the spec", async () => {
    const { result, goP, tsP } = await compareSteps(
      "full",
      [
        { args: ["doc", "edit", "architecture", "--path", "design/arch"] },
        { args: ["doc", "guides/links", "--plain"] },
        { args: ["validate", "--plain"] },
      ],
      seed,
    );
    cleanup.push(goP, tsP);
    expect(result.ts).toEqual(result.go);
    expect(treeContentDiff(result.goTree, result.tsTree)).toEqual([]);
    const links = readFileSync(join(tsP.dir, ".knowns/docs/guides/links.md"), "utf8");
    expect(links).toContain("@doc/design/arch#overview{implements}");
    // Go rewrites with strings.ReplaceAll of the raw token, so it also rewrites the prefix of
    // "@doc/architecture2"; the TS port matches that (the full-file comparison above proves it).
    expect(links).toContain("@doc/design/arch2");
    // ReplaceAll is textual, so the fenced occurrence is rewritten too (as in Go).
    expect(links).toContain("@doc/design/arch stays in a fence");
  });

  test("rename plus a content edit in one command", async () => {
    await expectParity(
      "full",
      [
        {
          args: [
            "doc",
            "edit",
            "architecture",
            "--path",
            "moved",
            "-a",
            "see @doc/architecture too",
          ],
        },
        { args: ["doc", "moved", "--plain"] },
        { args: ["doc", "history", "moved", "--plain"] },
      ],
      seed,
    );
  });

  test("default rewrite is wired (rename never throws 'not wired')", async () => {
    const p = makeProject("full", seed);
    cleanup.push(p);
    const r = await runTsIn(p, ["doc", "edit", "architecture", "--path", "wired/arch"]);
    expect(r.stderr).not.toContain("not wired");
    expect(r.code).toBe(0);
  });
});
