// Renders the CLI reference (docs/en/cli-reference) from the TypeScript command tree, and can
// verify that the committed copy still matches. A port of tools/gendocs, which rendered the same
// pages from the Go cobra tree; the output is byte-identical for the 0.34.1 command set.
//
// The point is not the docs themselves but the gate: without it, a reference page can describe a
// command the binary never had, or miss one it does. CI runs --check and --lint.
//
// Usage (from cli/):
//   bun scripts/gen-cli-docs.ts [--out <dir>]   write the pages (default ../docs/en/cli-reference)
//   bun scripts/gen-cli-docs.ts --check         fail if the committed pages differ; write nothing
//   bun scripts/gen-cli-docs.ts --lint          fail if hand-written docs use a missing command/flag
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { lintDocs, lintPaths } from "../src/cli/docs/lint.ts";
import { renderTree } from "../src/cli/docs/render.ts";
import { loadCommandTree } from "../src/cli/docs/tree.ts";

const repo = resolve(import.meta.dir, "../..");
const DEFAULT_OUT = join(repo, "docs/en/cli-reference");

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(msg: string): never {
  process.stderr.write(`gen-cli-docs: ${msg}\n`);
  process.exit(1);
}

function mdFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name);
}

function write(dir: string, pages: Map<string, string>): void {
  mkdirSync(dir, { recursive: true });
  // Drop pages for commands that no longer exist, so a removed command cannot leave a stale page.
  for (const name of mdFiles(dir)) if (!pages.has(name)) rmSync(join(dir, name));
  for (const [name, body] of pages) writeFileSync(join(dir, name), body);
}

function verify(dir: string, pages: Map<string, string>): string | undefined {
  const missing: string[] = [];
  const changed: string[] = [];
  for (const [name, want] of pages) {
    const file = join(dir, name);
    if (!existsSync(file)) missing.push(name);
    else if (readFileSync(file, "utf8") !== want) changed.push(name);
  }
  const stale = existsSync(dir) ? mdFiles(dir).filter((n) => !pages.has(n)) : [];
  if (missing.length + stale.length + changed.length === 0) return undefined;

  let out = "CLI reference is out of date. Run: make cli-docs\n";
  const report = (label: string, names: string[]): void => {
    if (names.length === 0) return;
    out += `\n  ${label}:\n`;
    for (const n of names.sort()) out += `    ${n}\n`;
  };
  report("missing (command exists, page does not)", missing);
  report("stale (page exists, command does not)", stale);
  report("changed (flags or help text differ)", changed);
  return out;
}

const root = await loadCommandTree();

if (process.argv.includes("--lint")) {
  // Both checks always run: exiting inside the first would hide every broken file reference until
  // the last broken flag was fixed.
  let bad = false;
  const docs = lintDocs(root, repo);
  if (docs.findings.length === 0) {
    process.stdout.write(
      `Docs are consistent with the command tree (${docs.checked} invocations checked).\n`,
    );
  } else {
    bad = true;
    process.stderr.write("Docs reference commands or flags that do not exist:\n\n");
    for (const f of docs.findings) process.stderr.write(`  ${f.file}:${f.line}  ${f.detail}\n`);
    process.stderr.write(
      `\n${docs.findings.length} of ${docs.checked} fenced invocations are broken.\n`,
    );
  }
  const paths = lintPaths(repo);
  if (paths.findings.length === 0) {
    process.stdout.write(`Docs reference ${paths.checked} files, all of which exist.\n`);
  } else {
    bad = true;
    process.stderr.write("\nDocs reference files that do not exist:\n\n");
    for (const f of paths.findings) process.stderr.write(`  ${f.file}:${f.line}  ${f.token}\n`);
    process.stderr.write(
      `\n${paths.findings.length} of ${paths.checked} file references are broken.\nFix the reference, or add it to ${paths.allowFile} with a reason.\n`,
    );
  }
  process.exit(bad ? 1 : 0);
}

const pages = renderTree(root);
if (pages.size === 0) fail("command tree produced no pages");
const out = argValue("--out") ? resolve(argValue("--out") as string) : DEFAULT_OUT;

if (process.argv.includes("--check")) {
  const problem = verify(out, pages);
  if (problem) fail(problem);
  process.stdout.write(`CLI reference is up to date (${pages.size} pages).\n`);
  process.exit(0);
}

write(out, pages);
process.stdout.write(`Wrote ${pages.size} pages to ${out}.\n`);
