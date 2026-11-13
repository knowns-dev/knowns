// Spec D14 adds `knowns qdrant setup` (@doc/specs/2026-11-07/qdrant-setup-wizard) on top of the
// 0.34.1 baseline. Tests that diff help or completion against the baseline oracle drop exactly
// that subcommand row first; its behavior is tested in test/runtime/qdrant-setup.test.ts. The
// patterns are literal, so anything else that differs still fails.

const ANSI = "(?:\\x1b\\[[0-9;]*m)?";
const SHORT = "Detect and set up a Qdrant for semantic search on this machine";

const PATTERNS: RegExp[] = [
  // The subcommand row in `qdrant` help and in unknown-subcommand output.
  new RegExp(`^ +${ANSI}setup${ANSI} +${SHORT}\\n`, "gm"),
  // Completion candidates after `qdrant`, with and without descriptions. A bare `setup` line is
  // also the root `knowns setup` command: apply this only to output that follows `qdrant`.
  new RegExp(`^setup(?:\\t${SHORT})?\\n`, "gm"),
];

// Literal [TS, 0.34.1] pairs: wording D14 changed rather than added. The doctor remediation for a
// missing managed binary also points at `knowns qdrant setup` (spec FR-12).
const REWORDED: Array<[string, string]> = [
  [
    "or export KNOWNS_QDRANT_URL (see docs/en/reference/external-qdrant.md), or run `knowns qdrant setup`.",
    "or export KNOWNS_QDRANT_URL. See docs/en/reference/external-qdrant.md.",
  ],
];

/** The TypeScript output with the D14 additions removed, for a diff against the 0.34.1 oracle. */
export function withoutD14(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, "");
  for (const [ts, go] of REWORDED) out = out.replaceAll(ts, go);
  return out;
}
