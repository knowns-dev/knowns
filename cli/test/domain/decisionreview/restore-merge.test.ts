// KN-XAA6KA: restoring a draft that the old link_as_related folded into a current decision. The
// pre-merge target is not stored, so the restore lists every shared entry and removes all but the
// ones named in keep.
import { afterAll, describe, expect, test } from "bun:test";
import { DecisionReviewService } from "../../../src/domain/decisionreview/index.ts";
import { cleanupLabs, lab } from "../world.ts";

afterAll(cleanupLabs);

const BUN = "20261103-1337-use-bun-for-everything";
const evidence = { sources: ["@doc/architecture"], relatedTasks: ["FX-3VT2SR"] };

async function incident() {
  const l = lab();
  const svc = new DecisionReviewService(l.storage);
  // the target owns T1..T3 (plus whatever the fixture gives it)
  await l.storage.decisions.link(BUN, [], ["T1", "T2", "T3"], []);
  const pre = l.storage.decisions.get(BUN);
  const added = await svc.add({
    id: "",
    title: "Use bun for everything",
    status: "",
    createdAt: "",
    updatedAt: "",
    decision: "Bun everywhere",
    ...evidence,
  });
  const id = added.decision?.id as string;
  // the draft holds 6 new tasks and T1, which the target also owns
  await l.storage.decisions.link(id, [], ["T1", "N1", "N2", "N3", "N4", "N5", "N6"], []);
  // the fold itself, without the review gate: the incident tasks are not real task files
  await l.storage.decisions.mergeCandidateIntoCurrent(id, BUN);
  return { l, svc, id, pre };
}

describe("restoreMerged", () => {
  test("incident shape: fold, dry run, restore with --keep for the shared task", async () => {
    const { l, svc, id, pre } = await incident();
    const folded = l.storage.decisions.get(BUN);
    expect(folded.relatedTasks?.length).toBe(
      (pre.relatedTasks?.length ?? 0) + 6 + (pre.relatedTasks?.includes("FX-3VT2SR") ? 0 : 1),
    );
    expect(l.storage.decisions.get(id).status).toBe("rejected");

    const preview = await svc.restoreMerged(id, BUN, {});
    expect(preview.state).toBe("preview");
    expect(preview.message).toContain("pre-merge state is not stored");
    expect(preview.entries.every((e) => e.action === "will remove")).toBe(true);
    expect(preview.entries.map((e) => e.entry)).toContain("T1");
    // a dry run writes nothing
    expect(l.storage.decisions.get(BUN)).toEqual(folded);
    expect(l.storage.decisions.get(id).status).toBe("rejected");

    // keep everything the target owned before the fold (what the human found in git history)
    const keep = preview.entries
      .map((e) => e.entry)
      .filter(
        (e) =>
          pre.relatedTasks?.includes(e) || pre.relatedDocs?.includes(e) || pre.sources?.includes(e),
      );
    expect(keep).toContain("T1");
    const done = await svc.restoreMerged(id, BUN, { apply: true, keep });
    expect(done.state).toBe("restored");

    const target = l.storage.decisions.get(BUN);
    expect(target.relatedTasks).toEqual(pre.relatedTasks);
    expect(target.relatedDocs).toEqual(pre.relatedDocs);
    expect(target.sources).toEqual([...(pre.sources ?? []), `@decision/${id}`]);
    const draft = l.storage.decisions.get(id);
    expect(draft.status).toBe("draft");
    expect(draft.reviewState).not.toBe("");
    expect(draft.sources).toContain(`@decision/${BUN}`);
    expect(draft.relatedTasks).toContain("N6");
  });

  test("running it twice is a clear no-op", async () => {
    const { svc, id } = await incident();
    await svc.restoreMerged(id, BUN, { apply: true });
    const again = await svc.restoreMerged(id, BUN, { apply: true });
    expect(again.state).toBe("already_restored");
    expect(again.message).toContain("nothing to restore");
    expect(again.changedIds).toEqual([]);
  });

  test("refuses unless the exact fold signature matches", async () => {
    const { l, svc, id } = await incident();
    await expect(svc.restoreMerged(id, "20261103-1337-adopt-a-monorepo", {})).rejects.toThrow(
      "was not folded into",
    );
    await expect(svc.restoreMerged(BUN, id, {})).rejects.toThrow("not a rejected fold");
    await expect(svc.restoreMerged(id, BUN, { keep: ["nope"] })).rejects.toThrow(
      "is not an entry the draft shares",
    );
    expect(l.storage.decisions.get(id).status).toBe("rejected");
  });

  test("a pure link is not a fold: restore refuses nothing to undo", async () => {
    const l = lab();
    const svc = new DecisionReviewService(l.storage);
    const added = await svc.add({
      id: "",
      title: "Use bun for everything",
      status: "",
      createdAt: "",
      updatedAt: "",
      decision: "x",
      ...evidence,
    });
    const id = added.decision?.id as string;
    await svc.resolve(undefined, { candidateId: id, resolution: "link_as_related", targetId: BUN });
    const r = await svc.restoreMerged(id, BUN, { apply: true });
    expect(r.state).toBe("already_restored");
  });
});
