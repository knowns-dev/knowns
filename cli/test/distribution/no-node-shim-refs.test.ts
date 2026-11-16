// bin/knowns.js is a native binary after an npm install (macOS and Linux), so nothing Knowns writes
// may tell anyone to run it with node.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* sources(p);
    else if (/\.(ts|tsx|md|tmpl)$/.test(name)) yield p;
  }
}

test("no source or generated guidance emits `node .../bin/knowns.js`", () => {
  const roots = [join(import.meta.dir, "..", "..", "src")];
  const hits: string[] = [];
  for (const root of roots) {
    for (const file of sources(root)) {
      if (/bin[\\/]knowns\.js/.test(readFileSync(file, "utf8"))) hits.push(file);
    }
  }
  expect(hits).toEqual([]);
});
