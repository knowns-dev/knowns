// The Runtime page in the UI does not poll for status; the daemon tells it when it changed.
import { expect, test } from "bun:test";
import { emitRuntimeStatus, onRuntimeStatusChange } from "../../src/runtime/status-events.ts";

test("only a change of the status key or the queue fingerprint is announced", () => {
  let n = 0;
  const off = onRuntimeStatusChange(() => n++);
  emitRuntimeStatus("a", "q1"); // baseline (or already seen by an earlier test: not asserted)
  const base = n;
  for (let i = 0; i < 20; i++) emitRuntimeStatus("a", "q1");
  expect(n).toBe(base);
  emitRuntimeStatus("a", "q2");
  expect(n).toBe(base + 1);
  emitRuntimeStatus("b", "q2");
  expect(n).toBe(base + 2);
  off();
  emitRuntimeStatus("c", "q2");
  expect(n).toBe(base + 2);
});

test("a throwing listener does not stop the others or the loop", () => {
  let n = 0;
  const offA = onRuntimeStatusChange(() => {
    throw new Error("boom");
  });
  const offB = onRuntimeStatusChange(() => n++);
  emitRuntimeStatus("x", "1");
  emitRuntimeStatus("x", "2");
  expect(n).toBe(2);
  offA();
  offB();
});
