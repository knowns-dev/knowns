// AC2: what sync writes comes from the same files Go embeds, and a change to either side fails.
//
// Go embeds internal/instructions/skills/kn-* and internal/instructions/guidelines/unified/*.md
// (`//go:embed`, which skips names starting with "." or "_"). The TypeScript build embeds a
// generated copy of the same trees; these tests compare it with the sources byte for byte, then
// check that a real sync writes exactly those bytes.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  runSyncInstructions,
  runSyncSkillsForScope,
} from "../../../src/cli/commands/sync-support.ts";
import {
  builtInSkillCount,
  generateInstructionContent,
  guidelineFiles,
  listSkillDirs,
  skillFiles,
} from "../../../src/domain/instructions/index.ts";
import { allPlatformIds } from "../../../src/domain/setup/platforms.ts";
import {
  resolveSyncPlatformSelection,
  selectSyncInstructionDefs,
  syncInstructionPlatformDefs,
} from "../../../src/domain/setup/sync-platforms.ts";

const root = resolve(import.meta.dir, "..", "..", "..", "..");
const skillsSrc = join(root, "internal", "instructions", "skills");
const guidelinesSrc = join(root, "internal", "instructions", "guidelines", "unified");

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
      if (n.startsWith(".") || n.startsWith("_")) return [];
      const f = join(dir, n);
      return statSync(f).isDirectory() ? walk(f) : [f];
    });
}

/** The embedded file map the sources imply, with the same rules go:embed applies. */
function sourceMap(base: string, filter: (rel: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of walk(base)) {
    const rel = relative(base, f).split("\\").join("/");
    if (filter(rel)) out[rel] = readFileSync(f, "utf8");
  }
  return out;
}

describe("embedded instruction sources have not drifted from the Go embed trees", () => {
  test("skills: same paths and same bytes as internal/instructions/skills/kn-*", () => {
    const src = sourceMap(skillsSrc, (rel) => rel.startsWith("kn-"));
    expect(Object.keys(skillFiles).sort()).toEqual(Object.keys(src).sort());
    for (const [path, content] of Object.entries(src)) {
      expect(skillFiles[path], path).toBe(content);
    }
    expect(builtInSkillCount()).toBeGreaterThan(0);
  });

  test("guidelines: same paths and same bytes as guidelines/unified/*.md", () => {
    const src = sourceMap(guidelinesSrc, (rel) => rel.endsWith(".md") && !rel.includes("/"));
    expect(Object.keys(guidelineFiles).sort()).toEqual(Object.keys(src).sort());
    for (const [path, content] of Object.entries(src)) {
      expect(guidelineFiles[path], path).toBe(content);
    }
  });

  test("the generator's own --check agrees", () => {
    const r = Bun.spawnSync(
      ["bun", join(import.meta.dir, "..", "..", "..", "scripts", "gen-instructions.ts"), "--check"],
      {
        timeout: 60_000,
      },
    );
    expect(r.stderr.toString() + r.stdout.toString()).not.toContain("stale");
    expect(r.exitCode).toBe(0);
  });
});

describe("sync writes exactly the embedded bytes", () => {
  const collect = () => {
    const out: string[] = [];
    return { out, io: { print: (t: string) => out.push(t), printErr: (t: string) => out.push(t) } };
  };

  test("project skills equal the Go skill sources, for every platform directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "knowns-sync-drift-"));
    try {
      runSyncSkillsForScope(collect().io, dir, [], "project", {});
      const src = sourceMap(skillsSrc, (rel) => rel.startsWith("kn-"));
      for (const sub of [".claude", ".agents", ".kiro"]) {
        const written = sourceMap(join(dir, sub, "skills"), () => true);
        expect(written).toEqual(src);
      }
      expect(listSkillDirs().length).toBe(builtInSkillCount());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("global skills land under HOME and equal the sources", () => {
    const dir = mkdtempSync(join(tmpdir(), "knowns-sync-drift-"));
    const home = mkdtempSync(join(tmpdir(), "knowns-sync-drift-home-"));
    try {
      runSyncSkillsForScope(collect().io, dir, ["claude-code"], "global", {
        HOME: home,
        USERPROFILE: home,
      });
      const src = sourceMap(skillsSrc, (rel) => rel.startsWith("kn-"));
      expect(sourceMap(join(home, ".claude", "skills"), () => true)).toEqual(src);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("instruction shims are the generated content", () => {
    const dir = mkdtempSync(join(tmpdir(), "knowns-sync-drift-"));
    try {
      runSyncInstructions(collect().io, dir, "", []);
      for (const d of syncInstructionPlatformDefs) {
        expect(readFileSync(join(dir, d.relPath), "utf8")).toBe(
          generateInstructionContent(d.relPath, d.label, dir),
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("platform selection", () => {
  test("claude aliases and all", () => {
    expect(resolveSyncPlatformSelection("claude", [])).toEqual(["claude-code"]);
    expect(resolveSyncPlatformSelection("ALL", [])).toEqual([...allPlatformIds]);
    expect(resolveSyncPlatformSelection("", ["cursor"])).toEqual(["cursor"]);
    expect(() => resolveSyncPlatformSelection("x", [])).toThrow('unknown platform "x"');
  });

  test("instruction defs follow aliases and config ids", () => {
    expect(selectSyncInstructionDefs("hermes", []).map((d) => d.name)).toEqual(["agents"]);
    expect(selectSyncInstructionDefs("", ["codex"]).map((d) => d.name)).toEqual(["agents"]);
    expect(selectSyncInstructionDefs("", ["kiro"])).toEqual([]);
    expect(() => selectSyncInstructionDefs("kiro", [])).toThrow("unknown platform");
  });
});

describe("layering", () => {
  test("nothing under src/domain imports src/cli", () => {
    const domain = join(root, "cli", "src", "domain");
    const offenders: string[] = [];
    const visit = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) visit(full);
        else if (full.endsWith(".ts")) {
          const text = readFileSync(full, "utf8");
          if (/from\s+["'](\.\.\/)+cli\//.test(text)) offenders.push(relative(domain, full));
        }
      }
    };
    visit(domain);
    expect(offenders).toEqual([]);
  });
});
