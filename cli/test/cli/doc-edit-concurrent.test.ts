// KN-V3GE5Q review: `knowns doc edit` without --expected-hash keeps concurrent edits.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispose, makeProject, type Project, runTsIn } from "../reconcile/harness.ts";

const projects: Project[] = [];
afterEach(() => {
  for (const p of projects.splice(0)) dispose(p);
});

test("parallel doc edit --append processes all apply", async () => {
  const p = makeProject("full");
  projects.push(p);
  const n = 5;
  const outs = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      runTsIn(p, ["doc", "edit", "architecture", "--append", `appended-${i}`]),
    ),
  );
  expect(outs.map((o) => o.code)).toEqual(Array(n).fill(0));
  const text = readFileSync(join(p.dir, ".knowns", "docs", "architecture.md"), "utf8");
  for (let i = 0; i < n; i++) expect(text).toContain(`appended-${i}`);
});
