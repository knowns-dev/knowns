// D8 (TSR-8WCHX1): `knowns import` was removed. Content already in .knowns/imports/ stays readable
// and searchable, and doctor says so. A fresh project always has an empty imports/ directory
// (`knowns init` creates it), so only a directory that holds something is reported; this keeps the
// default doctor output (including the skip count) identical to 0.34.1 for projects that never
// imported anything.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { DoctorProject } from "./foundation.ts";
import type { Checker } from "./model.ts";

/** The checker, or undefined when imports/ is missing or empty (no check is emitted at all). */
export function importsRemovedChecker(project: DoctorProject | undefined): Checker | undefined {
  if (!project) return undefined;
  const dir = join(project.store.root, "imports");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  if (entries.length === 0) return undefined;
  return {
    id: "project.imports",
    scope: "project",
    check: () => ({
      status: "warn",
      summary: "Import management was removed; imported content stays readable",
      evidence: { path: dir, entries: entries.length },
      remediation: {
        description:
          "`knowns import` no longer exists. Content already in .knowns/imports/ remains readable and searchable; manage it as plain files, or copy what you still need into your own docs and templates.",
      },
    }),
  };
}
