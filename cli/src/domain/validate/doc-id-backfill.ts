// TS-only addition beyond 0.34.1 (TSR-WR33ZF): give legacy Docs a stable id from `validate --fix`.
//
// Docs written before stable ids (0.25.x and older) have no `id:` in their frontmatter. Go assigns
// one only inside DocStore.writeFile, i.e. on the next edit, and the filesystem reconciler refuses
// a whole store while such a Doc exists (internal/storage/reconciler.go), which blocks task and doc
// hard-delete. This backfill does what writeFile would do for an id-only change, and nothing else:
//
// - The id is newDocId(), the same `doc-` + 32 hex form as Go's newDocID.
// - One line, `id: <id>`, is inserted as the first frontmatter line, which is where Go's renderDoc
//   puts it. Every other byte stays as it was (fields, order, quoting, body, newline style, BOM),
//   so a canonical file ends up byte-identical to renderDoc's output, and a non-canonical one is
//   not reformatted.
// - No history record is written. writeFile never records history itself, and the reconciler,
//   on first sight of an id with no stream, migrates the Doc's legacy path-keyed history
//   (versions/doc-<path>.json) through the VersionStore. A record written here would start a new
//   revision-1 stream under the id and orphan that legacy history.
// - updatedAt is not touched: assigning an identity is not an edit of the Doc.
import { readFileSync } from "node:fs";
import { atomicWrite, goTrimSpace } from "../../storage/core/util.ts";
import { newDocId, parseDocContent, resolveDocPath } from "../../storage/stores/doc-store.ts";

export const DOC_MISSING_ID = "DOC_MISSING_ID";

export type BackfillOutcome =
  | { status: "assigned"; id: string }
  /** Another writer gave the Doc an id between listing and fixing. */
  | { status: "already"; id: string }
  /** No frontmatter block to put an id into; Go would have to rewrite the whole file. */
  | { status: "no-frontmatter" };

const BOM = "﻿";

/**
 * The file content with `id: <id>` inserted as the first frontmatter line, or undefined when the
 * content has no frontmatter opening line. The newline style of the opening line is reused.
 */
export function insertDocId(raw: string, id: string): string | undefined {
  const bom = raw.startsWith(BOM) ? BOM : "";
  const content = raw.slice(bom.length);
  let nl: string;
  if (content.startsWith("---\r\n")) nl = "\r\n";
  else if (content.startsWith("---\n")) nl = "\n";
  else return undefined;
  const open = `---${nl}`;
  return `${bom}${open}id: ${id}${nl}${content.slice(open.length)}`;
}

/** Gives the Doc at docsDir/path a stable id if it has none. Re-reads the file first. */
export function backfillDocId(docsDir: string, path: string): BackfillOutcome {
  const { abs } = resolveDocPath(docsDir, path);
  const raw = readFileSync(abs, "utf8");
  const before = parseDocContent(raw, path, "", false, "");
  const existing = goTrimSpace(before.id ?? "");
  if (existing !== "") return { status: "already", id: existing };
  const id = newDocId();
  const next = insertDocId(raw, id);
  if (next === undefined) return { status: "no-frontmatter" };
  // The result must parse to the same Doc with only the id added.
  const after = parseDocContent(next, path, "", false, "");
  if (goTrimSpace(after.id ?? "") !== id) {
    throw new Error(`doc ${path}: inserted id did not parse back`);
  }
  const { id: _added, ...afterRest } = after;
  const { id: _none, ...beforeRest } = before;
  if (JSON.stringify(afterRest) !== JSON.stringify(beforeRest)) {
    throw new Error(`doc ${path}: inserting the id changed how the doc parses; not written`);
  }
  atomicWrite(abs, next);
  return { status: "assigned", id };
}
