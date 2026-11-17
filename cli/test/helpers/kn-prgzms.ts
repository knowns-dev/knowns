// KN-PRGZMS (0.35.1 hotfix) adds the accept_distinct resolution and `decision resolve --reason` on
// top of the 0.34.1 baseline. Tests that diff help, docs or the MCP tool list against the baseline
// oracle drop exactly these additions from the TS side first, so anything else that differs still
// fails. Behavior is tested in test/domain/decisionreview/accept-distinct.test.ts.
import { withoutXaa6ka } from "./kn-xaa6ka.ts";

const LONG_SENTENCE =
  " accept_distinct accepts a draft whose matches are not duplicates, keeps the matched decisions current, and requires --reason (recorded on the accepted decision). It is a human-gated operation like accept_new.";

export function withoutAcceptDistinct(text: string): string {
  return text
    .replace(LONG_SENTENCE, "")
    .replace("accept_new, accept_distinct, ", "accept_new, ")
    .replace(/^ *--reason string +Reviewer reason, required by accept_distinct\n/gm, "")
    .replace(
      /^\| `--reason` \| `string` \| — \| Reviewer reason, required by accept_distinct \|\n/gm,
      "",
    )
    .replace(/^ *(- |")accept_distinct"?,?\n/gm, "")
    .replace(/accept_distinct, /g, "")
    .replace('"accept_distinct",', "")
    .replace(/accept_distinct,\s*/g, "")
    .replace(
      "Reviewed archive/reject rationale (migration_apply); reviewer reason required by accept_distinct (resolve), recorded as a verification line per dismissed match",
      "Reviewed archive/reject rationale",
    )
    .replace(
      "accept_distinct (needs reason; keeps matched decisions current; refused for exact duplicates), ",
      "",
    );
}

/** The TS output with both hotfix additions (KN-PRGZMS, KN-XAA6KA) removed. */
export function withoutHotfix(text: string): string {
  return withoutXaa6ka(withoutAcceptDistinct(text));
}
