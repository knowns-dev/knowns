// template command tree against the Go 0.34.1 oracle (stdout, stderr, exit code, on-disk tree).
import { afterEach, describe, expect, test } from "bun:test";
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

/** Compares every step; also the project tree, which here includes generated source files. */
async function expectParity(
  fixture: string,
  steps: Step[],
  setup?: (dir: string) => void,
  extraTrees: string[] = [],
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
  // Generated files live outside .knowns; compare the paths the commands print instead (they are
  // part of stdout) and any extra files the case names.
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  for (const rel of extraTrees) {
    const a = existsSync(join(goP.dir, rel)) ? readFileSync(join(goP.dir, rel), "utf8") : null;
    const b = existsSync(join(tsP.dir, rel)) ? readFileSync(join(tsP.dir, rel), "utf8") : null;
    expect({ rel, content: b }).toEqual({ rel, content: a });
  }
}

const TPL_YAML = (extra: string): string => `# Template: scratch
name: scratch
description: Scratch template
version: 2.1.0
author: Someone
destination: out
${extra}
`;

const seed = (dir: string): void => {
  writeText(
    dir,
    ".knowns/templates/scratch/_template.yaml",
    TPL_YAML(`doc: "architecture"
prompts:
  - name: name
    type: text
    message: "Name?"
    validate: required
  - name: kind
    type: select
    message: "Kind?"
    initial: widget
  - name: flag
    type: confirm
    message: "Flag?"
actions:
  - type: add
    template: "main.hbs"
    path: "{{pascalCase name}}.txt"
  - type: add
    template: "main.hbs"
    path: "skip.txt"
    skipIfExists: true
  - type: append
    template: "line.hbs"
    path: "log.txt"
    unique: true
  - type: addMany
    source: "files"
    destination: "many/{{kebabCase name}}"
  - type: add
    template: "main.hbs"
    path: "never.txt"
    when: "flag"
messages:
  success: "Generated {{upperCase name}} of {{kind}}"
`),
  );
  writeText(
    dir,
    ".knowns/templates/scratch/main.hbs",
    "name={{name}} kind={{kind}} {{camelCase name}}\n{{#if flag}}flagged{{else}}plain{{/if}}\n",
  );
  writeText(dir, ".knowns/templates/scratch/line.hbs", "// {{snakeCase name}}\n");
  writeText(
    dir,
    ".knowns/templates/scratch/files/a.ts.hbs",
    "export const {{camelCase name}} = 1;\n",
  );
  writeText(dir, ".knowns/templates/scratch/files/sub/b.md.hbs", "# {{startCase name}}\n");
  writeText(dir, "out/skip.txt", "already here\n");
  writeText(
    dir,
    ".knowns/templates/broken/_template.yaml",
    `name: broken
actions:
  - type: add
    template: "missing.hbs"
    path: "{{unknownHelper name}}.txt"
  - type: add
    template: "bad.hbs"
    path: "x.txt"
`,
  );
  writeText(dir, ".knowns/templates/broken/bad.hbs", "{{#if}}\n{{name\n");
  writeText(
    dir,
    ".knowns/imports/pkg/templates/imported-one/_template.yaml",
    "name: imported-one\ndescription: From a package with a very long description that must be truncated in the table\nactions:\n  - type: add\n    template: t.hbs\n    path: i.txt\n",
  );
  writeText(dir, ".knowns/imports/pkg/templates/imported-one/t.hbs", "imported {{x}}\n");
};

cases("template commands match Go", () => {
  const reads: string[][] = [
    ["template"],
    ["template", "--help"],
    ["template", "list"],
    ["template", "list", "--plain"],
    ["template", "list", "--json"],
    ["template", "list", "--local"],
    ["template", "list", "--imported"],
    ["template", "list", "--imported", "--plain"],
    ["template", "list", "--local", "--json"],
    ["template", "list", "--help"],
    ["template", "view", "scratch"],
    ["template", "view", "scratch", "--plain"],
    ["template", "view", "scratch", "--json"],
    ["template", "scratch"],
    ["template", "scratch", "--plain"],
    ["template", "component", "--plain"],
    ["template", "pkg/imported-one"],
    ["template", "pkg/imported-one", "--plain"],
    ["template", "pkg/imported-one", "--json"],
    ["template", "nope"],
    ["template", "../escape"],
    ["template", "view"],
    ["template", "view", "a", "b"],
    ["template", "run", "--help"],
    ["template", "create", "--help"],
    ["template", "view", "--help"],
    ["template", "bogus", "--flag"],
  ];
  for (const args of reads) {
    test(args.join(" "), async () => {
      await expectParity("full", one(args), seed);
    });
  }

  test("empty project lists nothing", async () => {
    for (const args of [
      ["template", "list"],
      ["template", "list", "--plain"],
      ["template", "list", "--json"],
      ["template", "list", "--local", "--json"],
    ]) {
      await expectParity("empty", one(args));
    }
  });

  test("outside a project", async () => {
    await expectParity("", one(["template", "list"]));
  });
});

const one = (args: string[]): Step[] => [{ args }];

cases("template run matches Go", () => {
  const runs: Array<[string, string[]]> = [
    ["dry run", ["template", "run", "scratch", "--dry-run", "-v", "name=hello world"]],
    [
      "dry run json",
      ["template", "run", "scratch", "--dry-run", "--json", "-v", "name=hello world"],
    ],
    ["real run", ["template", "run", "scratch", "-v", "name=hello world"]],
    ["real run json", ["template", "run", "scratch", "--json", "-v", "name=my thing"]],
    ["real run plain", ["template", "run", "scratch", "--plain", "-v", "name=my thing"]],
    ["when guard true", ["template", "run", "scratch", "-v", "name=n", "-v", "flag=true"]],
    ["when guard false", ["template", "run", "scratch", "-v", "name=n", "-v", "flag=false"]],
    ["override default", ["template", "run", "scratch", "-v", "name=n", "-v", "kind=gadget"]],
    ["value containing equals", ["template", "run", "scratch", "-v", "name=a=b=c"]],
    ["unicode value", ["template", "run", "scratch", "-v", "name=Tiếng Việt"]],
    ["missing required", ["template", "run", "scratch"]],
    ["bad var format", ["template", "run", "scratch", "-v", "noequals"]],
    ["unknown template", ["template", "run", "nope"]],
    ["no name", ["template", "run"]],
    ["imported template", ["template", "run", "pkg/imported-one", "-v", "x=1"]],
    ["broken template", ["template", "run", "broken", "--dry-run"]],
    ["component with defaults", ["template", "run", "component", "-v", "name=Foo Bar"]],
    ["component dry run", ["template", "run", "component", "--dry-run", "-v", "name=Foo Bar"]],
  ];
  for (const [name, args] of runs) {
    test(name, async () => {
      await expectParity("full", one(args), seed, [
        "out/HelloWorld.txt",
        "out/MyThing.txt",
        "out/skip.txt",
        "out/log.txt",
        "out/many/hello-world/a.ts",
        "out/many/my-thing/sub/b.md",
        "src/foo-bar.ts",
      ]);
    });
  }

  test("unique append is idempotent across runs", async () => {
    await expectParity(
      "full",
      [
        { args: ["template", "run", "scratch", "-v", "name=same"] },
        { args: ["template", "run", "scratch", "-v", "name=same"] },
      ],
      seed,
      ["out/log.txt", "out/Same.txt"],
    );
  });
});

cases("template create matches Go", () => {
  test("create", async () => {
    await expectParity("full", one(["template", "create", "fresh"]), undefined, []);
  });
  test("create with description", async () => {
    await expectParity("full", one(["template", "create", "fresh", "-d", "A fresh one"]));
  });
  test("create with doc link", async () => {
    await expectParity("full", [
      { args: ["template", "create", "fresh", "-d", "d", "--doc", "patterns/controller"] },
      { args: ["template", "fresh", "--plain"] },
      { args: ["validate", "--scope", "templates", "--plain"] },
    ]);
  });
  test("create doc link needing quotes", async () => {
    await expectParity("full", [
      { args: ["template", "create", "fresh", "--doc", 'we"ird\\path'] },
      { args: ["template", "fresh", "--json"] },
    ]);
  });
  test("create twice", async () => {
    await expectParity("full", [
      { args: ["template", "create", "fresh"] },
      { args: ["template", "create", "fresh"] },
    ]);
  });
  test("create nested name", async () => {
    await expectParity("full", one(["template", "create", "a/b"]));
  });
  test("create escaping name", async () => {
    await expectParity("full", one(["template", "create", "../esc"]));
  });
  test("create in empty project then list and run dry", async () => {
    await expectParity("empty", [
      { args: ["template", "create", "first", "-d", "one"] },
      { args: ["template", "list", "--plain"] },
      { args: ["template", "run", "first", "--dry-run", "--plain"] },
    ]);
  });
  test("create without a name", async () => {
    await expectParity("full", one(["template", "create"]));
  });
});
