// Engine.run against the Go engine: the same project tree is built twice, Go runs on one copy and
// the TypeScript port on the other, and the results, errors and resulting trees must be identical.
// The only normalisation is replacing each copy's temp root with <ROOT>.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Engine, TemplateRunError } from "../../../src/domain/codegen/index.ts";
import type { Template } from "../../../src/models/template.ts";
import { askGo, GO_ORACLE, type OracleResponse } from "./oracle.ts";

interface Scenario {
  name: string;
  /** Files created under the project root before the run (relative paths). */
  files: Record<string, string>;
  /** Template without `path`; `path` is set to <root>/.knowns/templates/t. */
  tmpl: Omit<Template, "path">;
  vars?: Record<string, string>;
  dryRun?: boolean;
}

const T = ".knowns/templates/t";

const scenarios: Scenario[] = [
  {
    name: "add inline and file",
    files: { [`${T}/main.hbs`]: "class {{pascalCase name}} {}\n", [`${T}/x.txt`]: "raw {{name}}" },
    tmpl: {
      name: "t",
      actions: [
        { type: "add", path: "src/{{kebabCase name}}.ts", template: "main.hbs" },
        { type: "add", path: "src/inline.txt", template: "inline {{name}}" },
        { type: "add", path: "src/sub/{{name}}.md", template: "x.txt" },
        { type: "add", path: "src/empty.txt" },
      ],
    },
    vars: { name: "my thing" },
  },
  {
    name: "add destination and absolute path",
    files: { [`${T}/main.hbs`]: "{{name}}" },
    tmpl: {
      name: "t",
      destination: "out/{{name}}",
      actions: [{ type: "add", path: "a.txt", template: "main.hbs" }],
    },
    vars: { name: "n" },
  },
  {
    name: "add skipIfExists",
    files: { [`${T}/main.hbs`]: "new", "src/a.txt": "old" },
    tmpl: {
      name: "t",
      actions: [
        { type: "add", path: "src/a.txt", template: "main.hbs", skipIfExists: true },
        { type: "add", path: "src/b.txt", template: "main.hbs", skipIfExists: true },
        { type: "add", path: "src/a.txt", template: "main.hbs" },
      ],
    },
  },
  {
    name: "add missing template file",
    files: {},
    tmpl: { name: "t", actions: [{ type: "add", path: "a.txt", template: "nope.hbs" }] },
  },
  {
    name: "add requires a path",
    files: {},
    tmpl: { name: "t", actions: [{ type: "add" }] },
  },
  {
    name: "add path parse error",
    files: {},
    tmpl: { name: "t", actions: [{ type: "add", path: "{{foo bar}}.txt", template: "x" }] },
  },
  {
    name: "add template render error",
    files: { [`${T}/bad.hbs`]: "line1\n{{#if x}}" },
    tmpl: { name: "t", actions: [{ type: "add", path: "a.txt", template: "bad.hbs" }] },
  },
  {
    name: "add dry run",
    files: { [`${T}/main.hbs`]: "x" },
    tmpl: { name: "t", actions: [{ type: "add", path: "a/b/c.txt", template: "main.hbs" }] },
    dryRun: true,
  },
  {
    name: "add write error through a file",
    files: { [`${T}/main.hbs`]: "x", blocker: "i am a file" },
    tmpl: { name: "t", actions: [{ type: "add", path: "blocker/c.txt", template: "main.hbs" }] },
  },
  {
    name: "unknown action",
    files: {},
    tmpl: { name: "t", actions: [{ type: "bogus" }] },
  },
  {
    name: "addMany default glob",
    files: {
      [`${T}/src/{{name}}.ts.hbs`]: "export const {{camelCase name}} = 1;\n",
      [`${T}/src/nested/readme.md.hbs`]: "# {{startCase name}}\n",
      [`${T}/src/nested/keep.txt`]: "not a template",
      [`${T}/src/z.hbs`]: "z",
    },
    tmpl: {
      name: "t",
      destination: "gen/{{kebabCase name}}",
      actions: [{ type: "addMany", source: "src" }],
    },
    vars: { name: "Foo Bar" },
  },
  {
    name: "addMany custom glob and destination",
    files: {
      [`${T}/s/a.txt.hbs`]: "A",
      [`${T}/s/b.md.hbs`]: "B",
      [`${T}/s/d/c.txt.hbs`]: "C",
    },
    tmpl: {
      name: "t",
      actions: [
        { type: "addMany", source: "s", globPattern: "*.txt.hbs", destination: "one" },
        { type: "addMany", source: "s", globPattern: "**/*.txt.hbs", destination: "two" },
        { type: "addMany", source: "s", globPattern: "d/**", destination: "three" },
        { type: "addMany", source: "s", globPattern: "[ab].*", destination: "four" },
        { type: "addMany", source: "s", globPattern: "?.md.hbs", destination: "five" },
      ],
    },
  },
  {
    name: "addMany skipIfExists",
    files: { [`${T}/s/a.hbs`]: "A", [`${T}/s/b.hbs`]: "B", "out/a": "keep" },
    tmpl: {
      name: "t",
      actions: [{ type: "addMany", source: "s", destination: "out", skipIfExists: true }],
    },
  },
  {
    name: "addMany missing source",
    files: {},
    tmpl: { name: "t", actions: [{ type: "addMany", source: "nope" }] },
  },
  {
    name: "addMany bad glob",
    files: { [`${T}/s/a.hbs`]: "A" },
    tmpl: { name: "t", actions: [{ type: "addMany", source: "s", globPattern: "[a" }] },
  },
  {
    name: "addMany bad destination template",
    files: { [`${T}/s/a.hbs`]: "A" },
    tmpl: { name: "t", actions: [{ type: "addMany", source: "s", destination: "{{foo bar}}" }] },
  },
  {
    name: "addMany bad file path template",
    files: { [`${T}/s/{{foo bar}}.hbs`]: "A" },
    tmpl: { name: "t", actions: [{ type: "addMany", source: "s", destination: "o" }] },
  },
  {
    name: "addMany dry run",
    files: { [`${T}/s/a.hbs`]: "A" },
    tmpl: { name: "t", actions: [{ type: "addMany", source: "s", destination: "o" }] },
    dryRun: true,
  },
  {
    name: "modify groups",
    files: {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Go replacement syntax
      [`${T}/m.hbs`]: "[$1-{{name}}-${2}-$$-$x-$9]",
      "f.txt": "alpha beta\ngamma delta\n",
    },
    tmpl: {
      name: "t",
      actions: [{ type: "modify", path: "f.txt", template: "m.hbs", pattern: "(\\w+) (\\w+)" }],
    },
    vars: { name: "N" },
  },
  {
    name: "modify named groups and anchors",
    files: {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Go replacement syntax
      [`${T}/m.hbs`]: "<${first}>",
      "f.txt": "one\ntwo\nthree\n",
    },
    tmpl: {
      name: "t",
      actions: [
        { type: "modify", path: "f.txt", template: "m.hbs", pattern: "(?m)^(?P<first>t\\w+)$" },
      ],
    },
  },
  {
    name: "modify empty matches",
    files: { "f.txt": "abc" },
    tmpl: { name: "t", actions: [{ type: "modify", path: "f.txt", template: "-", pattern: "x*" }] },
  },
  {
    name: "modify empty matches anchored",
    files: { "f.txt": "a\nb\n" },
    tmpl: {
      name: "t",
      actions: [{ type: "modify", path: "f.txt", template: "> ", pattern: "(?m)^" }],
    },
  },
  {
    name: "modify classes",
    files: { "f.txt": "Hello World 123 héllo\n" },
    tmpl: {
      name: "t",
      actions: [
        { type: "modify", path: "f.txt", template: "_", pattern: "[[:digit:]]+|\\s+|[^a-zA-Z_]" },
      ],
    },
  },
  {
    name: "modify case-insensitive",
    files: { "f.txt": "Foo foo FOO" },
    tmpl: {
      name: "t",
      actions: [{ type: "modify", path: "f.txt", template: "bar", pattern: "(?i)foo" }],
    },
  },
  {
    name: "modify dot and s flag",
    files: { "f.txt": "a\nb\n" },
    tmpl: {
      name: "t",
      actions: [
        { type: "modify", path: "f.txt", template: "X", pattern: "a.b" },
        { type: "modify", path: "f.txt", template: "Y", pattern: "(?s)a.b" },
      ],
    },
  },
  {
    name: "modify lazy and repeat",
    files: { "f.txt": "<<a>><<b>>" },
    tmpl: {
      name: "t",
      actions: [{ type: "modify", path: "f.txt", template: "[$1]", pattern: "<<(.+?)>>" }],
    },
  },
  {
    name: "modify bad patterns",
    files: { "f.txt": "x" },
    tmpl: {
      name: "t",
      actions: [{ type: "modify", path: "f.txt", template: "x", pattern: "(abc" }],
    },
  },
  {
    name: "modify bad pattern star",
    files: { "f.txt": "x" },
    tmpl: { name: "t", actions: [{ type: "modify", path: "f.txt", template: "x", pattern: "*a" }] },
  },
  {
    name: "modify bad pattern close",
    files: { "f.txt": "x" },
    tmpl: { name: "t", actions: [{ type: "modify", path: "f.txt", template: "x", pattern: "a)" }] },
  },
  {
    name: "modify bad pattern bracket",
    files: { "f.txt": "x" },
    tmpl: { name: "t", actions: [{ type: "modify", path: "f.txt", template: "x", pattern: "[a" }] },
  },
  {
    name: "modify bad pattern escape",
    files: { "f.txt": "x" },
    tmpl: {
      name: "t",
      actions: [{ type: "modify", path: "f.txt", template: "x", pattern: "\\q" }],
    },
  },
  {
    name: "modify bad pattern backreference",
    files: { "f.txt": "x" },
    tmpl: {
      name: "t",
      actions: [{ type: "modify", path: "f.txt", template: "x", pattern: "(a)\\1" }],
    },
  },
  {
    name: "modify bad pattern range",
    files: { "f.txt": "x" },
    tmpl: {
      name: "t",
      actions: [{ type: "modify", path: "f.txt", template: "x", pattern: "[z-a]" }],
    },
  },
  {
    name: "modify missing file",
    files: {},
    tmpl: {
      name: "t",
      actions: [{ type: "modify", path: "nope.txt", template: "x", pattern: "a" }],
    },
  },
  {
    name: "modify requires path",
    files: {},
    tmpl: { name: "t", actions: [{ type: "modify" }] },
  },
  {
    name: "modify dry run",
    files: { "f.txt": "aaa" },
    tmpl: { name: "t", actions: [{ type: "modify", path: "f.txt", template: "b", pattern: "a" }] },
    dryRun: true,
  },
  {
    name: "append new existing unique",
    files: { "log.txt": "first\n", [`${T}/l.hbs`]: "line {{n}}" },
    tmpl: {
      name: "t",
      actions: [
        { type: "append", path: "log.txt", template: "l.hbs" },
        { type: "append", path: "log.txt", template: "l.hbs", unique: true },
        { type: "append", path: "new.txt", template: "l.hbs" },
        { type: "append", path: "log.txt", template: "tail", separator: "--" },
        { type: "append", path: "log.txt", template: "tail", separator: "--", unique: true },
      ],
    },
    vars: { n: "1" },
  },
  {
    name: "append requires path",
    files: {},
    tmpl: { name: "t", actions: [{ type: "append" }] },
  },
  {
    name: "append dry run",
    files: { "log.txt": "x" },
    tmpl: { name: "t", actions: [{ type: "append", path: "log.txt", template: "y" }] },
    dryRun: true,
  },
  {
    name: "when guards",
    files: {},
    tmpl: {
      name: "t",
      actions: [
        { type: "add", path: "a.txt", template: "a", when: "yes" },
        { type: "add", path: "b.txt", template: "b", when: "no" },
        { type: "add", path: "c.txt", template: "c", when: "{{yes}}" },
        { type: "add", path: "d.txt", template: "d", when: "{{ no }}" },
        { type: "add", path: "e.txt", template: "e", when: "missing" },
        { type: "add", path: "f.txt", template: "f", when: "zero" },
        { type: "add", path: "g.txt", template: "g", when: "name" },
        { type: "add", path: "h.txt", template: "h", when: "yes && name" },
        { type: "add", path: "i.txt", template: "i", when: 'eq name "x"' },
        { type: "add", path: "j.txt", template: "j", when: "true" },
        { type: "add", path: "k.txt", template: "k", when: "false" },
        { type: "add", path: "l.txt", template: "l", when: ".yes" },
      ],
    },
    vars: { yes: "true", no: "false", zero: "0", name: "x" },
  },
  {
    name: "when error",
    files: {},
    tmpl: { name: "t", actions: [{ type: "add", path: "a.txt", template: "a", when: "(" }] },
  },
  {
    name: "when error fallback",
    files: {},
    tmpl: {
      name: "t",
      actions: [{ type: "add", path: "a.txt", template: "a", when: "{{foo bar}}" }],
    },
  },
  {
    name: "no actions",
    files: {},
    tmpl: { name: "t" },
  },
  {
    name: "stops at first error",
    files: {},
    tmpl: {
      name: "t",
      actions: [
        { type: "add", path: "ok.txt", template: "ok" },
        { type: "bogus" },
        { type: "add", path: "never.txt", template: "never" },
      ],
    },
  },
];

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
}

function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        out[`${relative(root, p)}/`] = "";
        walk(p);
      } else out[relative(root, p)] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}

function norm(s: string, root: string): string {
  return s.split(root).join("<ROOT>");
}

function normList(l: string[] | null | undefined, root: string): string[] {
  return (l ?? []).map((s) => norm(s, root).replaceAll("\\", "/"));
}

const suite = GO_ORACLE ? describe : describe.skip;

suite("Engine.run against the Go engine", () => {
  const base = mkdtempSync(join(tmpdir(), "codegen-run-"));
  const goRoots: string[] = [];
  const tsRoots: string[] = [];
  let goResults: OracleResponse[] = [];

  beforeAll(() => {
    scenarios.forEach((s, i) => {
      const g = join(base, `go-${i}`);
      const t = join(base, `ts-${i}`);
      for (const r of [g, t]) {
        mkdirSync(r, { recursive: true });
        writeTree(r, s.files);
        mkdirSync(join(r, T), { recursive: true });
      }
      goRoots.push(g);
      tsRoots.push(t);
    });
    goResults = askGo(
      scenarios.map((s, i) => ({
        op: "run" as const,
        root: goRoots[i],
        tmpl: { ...s.tmpl, path: join(goRoots[i] as string, T) },
        vars: s.vars ?? {},
        dryRun: s.dryRun ?? false,
      })),
    );
  });

  scenarios.forEach((s, i) => {
    test(s.name, () => {
      const goRoot = goRoots[i] as string;
      const tsRoot = tsRoots[i] as string;
      const go = goResults[i] as OracleResponse;
      const engine = new Engine(tsRoot);
      let err = "";
      let created: string[] = [];
      let modified: string[] = [];
      let skipped: string[] = [];
      try {
        const r = engine.run({ ...s.tmpl, path: join(tsRoot, T) }, s.vars ?? {}, s.dryRun ?? false);
        created = r.created ?? [];
        modified = r.modified ?? [];
        skipped = r.skipped ?? [];
      } catch (e) {
        err = (e as Error).message;
        expect(e).toBeInstanceOf(TemplateRunError);
        const r = (e as TemplateRunError).result;
        created = r.created ?? [];
        modified = r.modified ?? [];
        skipped = r.skipped ?? [];
      }
      expect({
        err: norm(err, tsRoot),
        created: normList(created, tsRoot),
        modified: normList(modified, tsRoot),
        skipped: normList(skipped, tsRoot),
      }).toEqual({
        err: norm(go.err, goRoot),
        created: normList(go.created, goRoot),
        modified: normList(go.modified, goRoot),
        skipped: normList(go.skipped, goRoot),
      });
      expect(readTree(tsRoot)).toEqual(readTree(goRoot));
    });
  });

  test("cleanup", () => {
    rmSync(base, { recursive: true, force: true });
  });
});
