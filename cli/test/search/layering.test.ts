// AC-5: the library reaches storage only through the public factory (type imports of the wired
// `Storage` from storage/adapters.ts) and imports no CLI code.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "src", "search");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const IMPORT = /^\s*(?:import|export)\s+(type\s+)?[^;]*?\bfrom\s+["']([^"']+)["']/gm;

describe("search library layering", () => {
  const all = files(SRC).map((file) => {
    const text = readFileSync(file, "utf8");
    const imports = [...text.matchAll(IMPORT)].map((m) => ({
      typeOnly: m[1] !== undefined,
      spec: m[2] as string,
    }));
    return { file: relative(SRC, file), imports };
  });

  test("imports nothing from the CLI, main, or the server", () => {
    const bad = all.flatMap((f) =>
      f.imports
        .filter(
          (i) =>
            /(^|\/)(cli|main\.ts|server|ui\.ts)(\/|$|\.)/.test(i.spec) && i.spec.startsWith("."),
        )
        .map((i) => `${f.file} -> ${i.spec}`),
    );
    expect(bad).toEqual([]);
  });

  test("storage is reached only through adapters.ts, and only for types", () => {
    const storageImports = all.flatMap((f) =>
      f.imports.filter((i) => i.spec.includes("/storage/")).map((i) => ({ file: f.file, ...i })),
    );
    expect(storageImports.length).toBeGreaterThan(0);
    for (const i of storageImports) {
      expect(i.spec.endsWith("/storage/adapters.ts"), `${i.file} imports ${i.spec}`).toBe(true);
      expect(i.typeOnly, `${i.file} must use a type-only import of ${i.spec}`).toBe(true);
    }
  });
});
