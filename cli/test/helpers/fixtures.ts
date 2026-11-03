// Access to the golden fixture projects produced by scripts/gen-fixtures.ts.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");

export interface FixtureEntry {
  description: string;
  ids: Record<string, string>;
  files: string[];
  digest: string;
  bomFiles?: string[];
}

export interface FixtureManifest {
  goVersion: string;
  fixtures: Record<string, FixtureEntry>;
}

export const manifest: FixtureManifest = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "manifest.json"), "utf8"),
) as FixtureManifest;

export const fixtureNames = Object.keys(manifest.fixtures);

export function fixtureRoot(name: string): string {
  return join(FIXTURES_DIR, name);
}

/** All files under a fixture directory, as forward-slash paths relative to it. */
export function fixtureFiles(name: string): string[] {
  const root = fixtureRoot(name);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(root, p).split(sep).join("/"));
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

export function readFixture(name: string, rel: string): string {
  return readFileSync(join(fixtureRoot(name), rel), "utf8");
}

export function fixtureId(name: string, logical: string): string {
  const id = manifest.fixtures[name]?.ids[logical];
  if (!id) throw new Error(`fixture ${name} has no id ${logical}`);
  return id;
}
