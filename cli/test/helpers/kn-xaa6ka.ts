// KN-XAA6KA (0.35.1 hotfix) adds the merge_duplicate resolution, makes link_as_related a pure link
// and adds `decision restore` on top of the 0.34.1 baseline. Tests that diff help, completion, docs
// or the MCP tool list against the baseline oracle drop exactly these additions first, so anything
// else that differs still fails. Behavior is tested in test/domain/decisionreview/.

const ANSI = "(?:\\x1b\\[[0-9;]*m)?";
const RESTORE_SHORT = "Restore a draft folded into a decision by the old link_as_related";

const PATTERNS: RegExp[] = [
  // The `restore` row in `decision` help, the completion candidate (with and without description)
  // and the page table row.
  new RegExp(`^ +${ANSI}restore${ANSI} +${RESTORE_SHORT}\\n`, "gm"),
  new RegExp(`^restore(?:\\t${RESTORE_SHORT})?\\n`, "gm"),
  new RegExp(
    `^- \\[\`knowns decision restore\`\\]\\(knowns_decision_restore\\.md\\) — ${RESTORE_SHORT}\\n`,
    "gm",
  ),
  // MCP tool schema: the restore action, its two arguments and the merge_duplicate enum value.
  /"restore",/g,
  /"merge_duplicate",/g,
  /"apply":\{"description":"Write the restore[^}]*\},/g,
  /"keep":\{"description":"Entries to keep on the target[^}]*\}[^}]*\},/g,
];

// Literal [TS, 0.34.1] pairs: wording the hotfix changed rather than added.
const REWORDED: Array<[string, string]> = [
  [
    "Existing Decision ID required by link_as_related, merge_duplicate or supersede_existing",
    "Existing Decision ID required by link_as_related or supersede_existing",
  ],
  [
    "Resolve a persisted candidate with accept_new, link_as_related, merge_duplicate, reject_new, or supersede_existing. link_as_related only links the two decisions (both keep their status). merge_duplicate folds the draft into the target and rejects the draft. Link, merge and replace require --target.",
    "Resolve a persisted candidate with accept_new, link_as_related, reject_new, or supersede_existing. Link and replace require --target.",
  ],
];

/** The TypeScript output with the KN-XAA6KA additions removed, for a diff against the 0.34.1 oracle. */
export function withoutXaa6ka(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, "");
  for (const [ts, go] of REWORDED) out = out.replaceAll(ts, go);
  return out;
}
