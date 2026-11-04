// Port of internal/references/rewrite.go.
import { goTrimSpace } from "../../storage/core/util.ts";
import { extract } from "./references.ts";

/**
 * RewriteDocPath rewrites inline @doc refs from oldPath to newPath while preserving doc fragments
 * and semantic relation suffixes.
 */
export function rewriteDocPath(content: string, oldPath: string, newPath: string): string {
  if (goTrimSpace(content) === "" || goTrimSpace(oldPath) === "" || oldPath === newPath) {
    return content;
  }
  let updated = content;
  for (const ref of extract(content)) {
    if (ref.type !== "doc" || ref.target !== oldPath) continue;
    let rewritten = `@doc/${newPath}`;
    if (ref.fragment) rewritten += ref.fragment.raw ?? "";
    if (ref.explicitRelation) rewritten += `{${ref.relation}}`;
    updated = updated.split(ref.raw).join(rewritten);
  }
  return updated;
}
