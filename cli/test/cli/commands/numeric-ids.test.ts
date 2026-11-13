// Frontmatter values YAML reads as numbers keep their literal text, as yaml.v3 does for a Go
// string field (TSR-5K4DQR): memory ids (`000681`, `1e5678`, `0x1f2a`), and task, doc and
// decision titles (`1e5`, `0x10`, `12e3`). The fixtures are written by Go and then given those
// values, the way a randomly generated id or a hand-edited title produces them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hasGoBin } from "../oracle.ts";
import { goInTemplate, makeSandbox, runGoIn, runTsIn, type Sandbox } from "./subprocess-diff.ts";

const t = test.skipIf(!hasGoBin);
const MEMORY_IDS = ["000681", "1e5678", "0x1f2a"];
let box: Sandbox;
let taskId = "";

function newest(dir: string, before: Set<string>): string {
  return readdirSync(dir).find((f) => !before.has(f)) as string;
}

/** Replaces a top-level `key: ...` line of a markdown file's frontmatter. */
function setLine(path: string, key: string, value: string): void {
  const text = readFileSync(path, "utf8").replace(
    new RegExp(`^${key}: .*$`, "m"),
    `${key}: ${value}`,
  );
  writeFileSync(path, text);
}

function findFile(dir: string, pred: (name: string) => boolean): string {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      const found = findFile(p, pred);
      if (found) return found;
    } else if (pred(name)) return p;
  }
  return "";
}

beforeAll(() => {
  if (!hasGoBin) return;
  box = makeSandbox("knowns-numeric-");
  mkdirSync(box.home, { recursive: true });
  mkdirSync(box.proj, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: box.proj });
  goInTemplate(box, ["init", "numbers", "--no-wizard"]);
  const kn = join(box.proj, ".knowns");

  const memDir = join(kn, "memory");
  for (const id of MEMORY_IDS) {
    const before = new Set(readdirSync(memDir));
    goInTemplate(box, [
      "memory",
      "create",
      `Memory ${id}`,
      "--category",
      "pattern",
      "--status",
      "active",
      "-c",
      `body ${id}`,
    ]);
    const file = join(memDir, newest(memDir, before));
    setLine(file, "id", id);
    renameSync(file, join(memDir, `memory-${id}.md`));
  }

  // Write commands print text even with --json: "✓ Created task XX-YYYYYY: ...".
  const created = goInTemplate(box, ["task", "create", "Numeric title task", "--plain"]);
  taskId = /Created task ([A-Za-z0-9-]+)/.exec(created)?.[1] ?? "";
  if (taskId === "") throw new Error(`no task id in: ${created}`);
  setLine(
    findFile(join(kn, "tasks"), (n) => n.includes(taskId)),
    "title",
    "1e5",
  );

  goInTemplate(box, ["doc", "create", "numeric-doc", "-c", "content"]);
  setLine(
    findFile(join(kn, "docs"), (n) => n === "numeric-doc.md"),
    "title",
    "0x10",
  );

  goInTemplate(box, [
    "decision",
    "create",
    "Numeric decision",
    "--context",
    "c",
    "--decision",
    "d",
    "--consequences",
    "q",
  ]);
  setLine(
    findFile(join(kn, "decisions"), (n) => n.includes("numeric-decision")),
    "title",
    "12e3",
  );
}, 60_000);

afterAll(() => {
  if (box) rmSync(box.root, { recursive: true, force: true });
});

async function same(args: string[]): Promise<void> {
  const opts = { watch: ["proj/.knowns/memory", "proj/.knowns/tasks", "proj/.knowns/docs"] };
  const go = await runGoIn(box, args, opts);
  const ts = await runTsIn(box, args, opts);
  expect(ts).toEqual(go);
}

describe("numeric-looking frontmatter values match Go", () => {
  t("memory list", () => same(["memory", "list", "--json"]));
  for (const id of MEMORY_IDS) {
    t(`memory view ${id}`, () => same(["memory", "view", id, "--json"]));
    t(`memory edit ${id}`, () => same(["memory", "edit", id, "--title", `Edited ${id}`]));
  }
  t("task list and view", async () => {
    await same(["task", "list", "--json"]);
    await same(["task", "view", taskId, "--json"]);
  });
  t("doc view", () => same(["doc", "view", "numeric-doc", "--json"]));
  t("decision list", async () => {
    await same(["decision", "list", "--all-statuses", "--json"]);
    const r = await runTsIn(box, ["decision", "list", "--all-statuses", "--json"]);
    expect(r.stdout).toContain("12e3");
  });
  t("the literal id reaches the output", async () => {
    const r = await runTsIn(box, ["memory", "view", "000681", "--json"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"id": "000681"');
  });
});
