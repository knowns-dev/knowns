// The lifecycle library is shared by the CLI, MCP and the HTTP server: it must not import any of them.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", "..", "..", "src", "domain", "tasklifecycle");

describe("domain/tasklifecycle layering", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));

  test("it has source files", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    test(`${file} imports nothing from the CLI, MCP or server layers`, () => {
      const source = readFileSync(join(DIR, file), "utf8");
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] as string);
      for (const spec of imports) {
        expect(spec).not.toMatch(/(^|\/)cli(\/|$)/);
        expect(spec).not.toMatch(/(^|\/)(mcp|server)(\/|$)/);
      }
    });
  }
});
