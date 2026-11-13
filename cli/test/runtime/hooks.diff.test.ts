// AC4/AC5 (inline mode): the doc, task, memory and decision write hooks leave the same runtime
// queue, project registry and Qdrant watermark files as the Go 0.34.1 binary.
import { describe, expect, test } from "bun:test";
import { hasGoBin, INLINE, makePair, runSide, runtimeSnapshot } from "./helpers.ts";

const suite = hasGoBin ? describe : describe.skip;

suite("write hooks queue the same runtime state as Go (inline mode)", () => {
  test("task and doc writes", async () => {
    const pair = makePair("full");
    const steps: string[][] = [
      ["task", "create", "Hook task", "-d", "from the hook test"],
      ["doc", "create", "Hook doc", "-d", "desc", "-c", "body text"],
      ["task", "edit", "<ID1>", "-d", "changed description"],
      ["doc", "edit", "hook-doc", "-c", "changed body"],
      ["doc", "delete", "hook-doc", "--yes"],
    ];
    for (const args of steps) {
      const go = await runSide(pair, "go", args, INLINE);
      const ts = await runSide(pair, "ts", args, INLINE);
      expect(ts.code, `${args.join(" ")}: ${ts.stderr}`).toBe(go.code);
      expect(pair.norm.text("ts", ts.stderr)).toBe(pair.norm.text("go", go.stderr));
    }
    const go = runtimeSnapshot(pair, "go");
    const ts = runtimeSnapshot(pair, "ts");
    expect(Object.keys(ts)).toEqual(Object.keys(go));
    expect(ts).toEqual(go);
    expect(Object.keys(go).length).toBeGreaterThan(1);
  }, 60_000);
});
