// `knowns import` was removed (spec D8). The command and every subcommand fail with a removal
// message and a non-zero exit; content already under .knowns/imports/ stays visible to search,
// doc view/list and template list exactly as Go 0.34.1 shows it (differential, no normalisation
// beyond the shared harness's timestamps and ids).
import { afterEach, describe, expect, test } from "bun:test";
import { IMPORT_REMOVED_MESSAGE } from "../../../src/cli/commands/import.ts";
import {
  compareSteps,
  dispose,
  hasGoBin,
  makeProject,
  type Project,
  runTsIn,
  treeContentDiff,
  writeText,
} from "./doc-harness.ts";

const cleanup: Project[] = [];
afterEach(() => {
  for (const p of cleanup.splice(0)) dispose(p);
});

describe("import: removal message", () => {
  const argSets = [
    ["import"],
    ["import", "list"],
    ["import", "add", "./pkg"],
    ["import", "add", "./pkg", "--name", "x", "--dry-run"],
    ["import", "remove", "pkg"],
    ["import", "status"],
    ["import", "sync"],
    ["import", "sync", "pkg", "--force"],
    ["import", "--json"],
  ];
  for (const args of argSets) {
    test(`knowns ${args.join(" ")} fails with the removal message`, async () => {
      const p = makeProject("full");
      cleanup.push(p);
      const r = await runTsIn(p, args);
      expect(r.code).not.toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(IMPORT_REMOVED_MESSAGE);
      expect(IMPORT_REMOVED_MESSAGE).not.toContain("—");
    });
  }

  test("does not touch .knowns/imports/", async () => {
    const p = makeProject("full", seed);
    cleanup.push(p);
    const before = await Bun.file(`${p.dir}/.knowns/imports/acme/docs/acme/intro.md`).text();
    await runTsIn(p, ["import", "remove", "acme"]);
    await runTsIn(p, ["import", "sync"]);
    expect(await Bun.file(`${p.dir}/.knowns/imports/acme/docs/acme/intro.md`).text()).toBe(before);
  });

  test("help still works and lists the removed subcommands", async () => {
    const p = makeProject("full");
    cleanup.push(p);
    for (const args of [
      ["import", "--help"],
      ["import", "sync", "--help"],
      ["import", "add", "-h"],
    ]) {
      const r = await runTsIn(p, args);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("removed");
    }
    const top = await runTsIn(p, ["import", "--help"]);
    for (const sub of ["list", "add", "remove", "status", "sync"])
      expect(top.stdout).toContain(sub);
  });

  test("root help still lists import", async () => {
    const p = makeProject("full");
    cleanup.push(p);
    const r = await runTsIn(p, ["--help"]);
    expect(r.stdout).toContain("import");
  });
});

const seed = (dir: string): void => {
  writeText(
    dir,
    ".knowns/imports/acme/_import.json",
    `${JSON.stringify({ source: "./acme", type: "local", lastSync: "2026-01-01T00:00:00Z", importedAt: "2026-01-01T00:00:00Z" }, null, 2)}\n`,
  );
  writeText(
    dir,
    ".knowns/imports/acme/docs/acme/intro.md",
    `---
id: doc-11111111111111111111111111111111
title: Acme Intro
description: Imported zebra handbook
createdAt: '2026-01-01T00:00:00.000Z'
updatedAt: '2026-01-01T00:00:00.000Z'
tags:
  - imported
---

# Acme Intro

The zebrafish protocol lives here.
`,
  );
  writeText(
    dir,
    ".knowns/imports/acme/docs/acme/guides/deep.md",
    `---
id: doc-22222222222222222222222222222222
title: Acme Deep
description: Nested imported doc
createdAt: '2026-01-01T00:00:00.000Z'
updatedAt: '2026-01-01T00:00:00.000Z'
---

Deep zebrafish content.
`,
  );
  writeText(
    dir,
    ".knowns/imports/acme/templates/widget/_template.yaml",
    `name: widget
description: Imported widget template
version: 1.0.0
destination: src
prompts:
  - name: name
    type: text
    message: "Name?"
actions: []
`,
  );
};

const cases = hasGoBin ? describe : describe.skip;

cases("imported content stays readable (matches Go)", () => {
  const steps = [
    ["doc", "list", "--plain"],
    ["doc", "list", "--json"],
    ["doc", "list"],
    ["doc", "acme/intro", "--plain"],
    ["doc", "view", "acme/guides/deep", "--plain"],
    ["doc", "view", "acme/intro", "--json"],
    ["doc", "acme/intro"],
    ["template", "list", "--plain"],
    ["template", "list", "--json"],
    ["template", "list"],
    ["template", "view", "acme/widget", "--plain"],
    ["search", "zebrafish", "--keyword", "--plain"],
    ["search", "zebrafish", "--keyword", "--json"],
    ["search", "zebrafish", "--keyword", "--type", "doc"],
    ["search", "widget", "--keyword", "--type", "template", "--plain"],
  ];

  test("doc, template and search outputs are identical to Go", async () => {
    const { result, goP, tsP } = await compareSteps(
      "full",
      steps.map((args) => ({ args })),
      seed,
    );
    cleanup.push(goP, tsP);
    for (let i = 0; i < steps.length; i++) {
      const label = (steps[i] as string[]).join(" ");
      expect({ step: label, ...(result.ts[i] as object) }).toEqual({
        step: label,
        ...(result.go[i] as object),
      });
    }
    expect(treeContentDiff(result.goTree, result.tsTree)).toEqual([]);
  });

  test("the seeded imports are actually visible (not vacuous parity)", async () => {
    const { result, goP, tsP } = await compareSteps(
      "full",
      steps.map((args) => ({ args })),
      seed,
    );
    cleanup.push(goP, tsP);
    expect(result.ts[0]?.stdout).toContain("acme/intro");
    expect(result.ts[3]?.stdout).toContain("zebrafish");
    expect(result.ts[7]?.stdout).toContain("widget");
    expect(result.ts[11]?.stdout).toContain("acme/intro");
  });
});
