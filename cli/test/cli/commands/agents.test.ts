// `knowns agents` against the Go 0.34.1 oracle (see sync-harness.ts for the comparison rules).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  dispose,
  hasGoBin,
  makePair,
  makeTemplate,
  projectTreeDiff,
  runBoth,
  type Side,
  writeText,
} from "./sync-harness.ts";

const cases = hasGoBin ? describe : describe.skip;
const SLOW = 120_000;
let tpl: Side | undefined;
const template = (): Side => {
  tpl ??= makeTemplate();
  return tpl;
};
afterAll(() => tpl && dispose(tpl));

async function parity(
  args: string[][],
  setup?: (dir: string) => void,
  cwdSub?: string,
): Promise<void> {
  const p = makePair(template());
  try {
    if (setup) {
      setup(p.go.dir);
      setup(p.ts.dir);
    }
    if (cwdSub) {
      for (const s of [p.go, p.ts]) {
        mkdirSync(join(s.dir, cwdSub), { recursive: true });
        s.dir = join(s.dir, cwdSub);
      }
    }
    for (const a of args) {
      const r = await runBoth(p, a);
      expect({ step: a.join(" "), ...r.ts }).toEqual({ step: a.join(" "), ...r.go });
    }
    if (!cwdSub) expect(projectTreeDiff(p)).toEqual([]);
  } finally {
    dispose(p.go, p.ts);
  }
}

cases("agents matches Go", () => {
  test(
    "every output mode on a fresh project",
    async () => {
      await parity([["agents"], ["agents", "--plain"], ["agents", "--json"]]);
    },
    SLOW,
  );

  test(
    "--help",
    async () => {
      await parity([["agents", "--help"]]);
    },
    SLOW,
  );

  test(
    "after sync: all five files exist",
    async () => {
      const p = makePair(template());
      try {
        const sync = await runBoth(p, ["sync", "--platform", "all", "--instructions"]);
        expect(sync.ts.code).toBe(sync.go.code);
        for (const a of [["agents"], ["agents", "--plain"], ["agents", "--json"]]) {
          const r = await runBoth(p, a);
          expect(r.ts).toEqual(r.go);
        }
      } finally {
        dispose(p.go, p.ts);
      }
    },
    SLOW,
  );

  test(
    "an empty file exists with size 0 (omitempty in JSON), a large one reports its size",
    async () => {
      const setup = (dir: string) => {
        writeText(dir, "OPENCODE.md", "");
        writeText(dir, "GEMINI.md", "x".repeat(12345));
      };
      await parity([["agents", "--plain"], ["agents", "--json"], ["agents"]], setup);
    },
    SLOW,
  );

  test(
    "a directory named like an instruction file still counts as existing",
    async () => {
      await parity(
        [
          ["agents", "--plain"],
          ["agents", "--json"],
        ],
        (dir) => {
          mkdirSync(join(dir, "GEMINI.md"), { recursive: true });
        },
      );
    },
    SLOW,
  );

  test(
    "run from a subdirectory finds the project root",
    async () => {
      await parity([["agents", "--plain"]], undefined, "src/deep");
    },
    SLOW,
  );

  test(
    "outside a project",
    async () => {
      const p = makePair(template());
      try {
        rmSync(join(p.go.dir, ".knowns"), { recursive: true });
        rmSync(join(p.ts.dir, ".knowns"), { recursive: true });
        const r = await runBoth(p, ["agents"]);
        expect(r.ts).toEqual(r.go);
        expect(r.ts.code).toBe(1);
      } finally {
        dispose(p.go, p.ts);
      }
    },
    SLOW,
  );
});
