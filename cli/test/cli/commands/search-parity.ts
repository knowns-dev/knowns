// Shared assertions for the search-group differential tests.
import { expect } from "bun:test";
import {
  type CompareOptions,
  compare,
  dispose,
  type Step,
  treeContentDiff,
} from "./search-harness.ts";

/** Runs `steps` on Go and TS and expects every result and the resulting tree to match. */
export async function expectParity(
  fixture: string,
  steps: Array<Step | string[]>,
  opts: CompareOptions = {},
): Promise<void> {
  const normalized = steps.map((s) => (Array.isArray(s) ? { args: s } : s));
  const c = await compare(fixture, normalized, opts);
  try {
    for (let i = 0; i < normalized.length; i++) {
      const label = (normalized[i] as Step).args.join(" ");
      expect({ step: label, ...(c.ts[i] as object) }).toEqual({
        step: label,
        ...(c.go[i] as object),
      });
    }
    expect(treeContentDiff(c.goTree, c.tsTree)).toEqual([]);
  } finally {
    dispose(c.goP);
    dispose(c.tsP);
  }
}
