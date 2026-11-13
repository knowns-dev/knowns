// The instruction and skill content init, sync and agents write must be the bytes Go embeds
// (`//go:embed kn-*` in internal/instructions/skills, `//go:embed unified/*.md` in
// internal/instructions/guidelines). embedded.generated.ts is produced by scripts/gen-instructions.ts;
// these tests read the Go source tree directly and compare, so a stale or lossy module fails.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { guidelineFiles, skillFiles } from "../../../src/domain/instructions/embedded.generated.ts";

const root = resolve(import.meta.dir, "..", "..", "..", "..", "internal", "instructions");

/** go:embed rule for directories: skip names starting with "." or "_". */
function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
      if (n.startsWith(".") || n.startsWith("_")) return [];
      const f = join(dir, n);
      return statSync(f).isDirectory() ? walk(f) : [f];
    });
}

describe("embedded instructions are the bytes Go embeds", () => {
  test("skills: same files, byte for byte", () => {
    const base = join(root, "skills");
    const dirs = readdirSync(base).filter(
      (n) => n.startsWith("kn-") && statSync(join(base, n)).isDirectory(),
    );
    const expected = new Map(
      dirs.flatMap((d) =>
        walk(join(base, d)).map((f) => [relative(base, f).split("\\").join("/"), f] as const),
      ),
    );
    expect(Object.keys(skillFiles).sort()).toEqual([...expected.keys()].sort());
    for (const [rel, file] of expected) {
      expect(Buffer.from(skillFiles[rel] as string, "utf8").equals(readFileSync(file))).toBe(true);
    }
    expect(expected.size).toBeGreaterThan(0);
  });

  test("guidelines: unified/*.md, byte for byte", () => {
    const base = join(root, "guidelines", "unified");
    const names = readdirSync(base)
      .filter((n) => n.endsWith(".md"))
      .sort();
    expect(Object.keys(guidelineFiles).sort()).toEqual(names);
    for (const n of names) {
      expect(
        Buffer.from(guidelineFiles[n] as string, "utf8").equals(readFileSync(join(base, n))),
      ).toBe(true);
    }
  });

  test("the generator's --check passes", () => {
    const r = Bun.spawnSync(
      ["bun", join(import.meta.dir, "..", "..", "..", "scripts", "gen-instructions.ts"), "--check"],
      { stderr: "pipe" },
    );
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
  });
});
