// The startup line of a detached `knowns browser` says when the UI closes by itself.
import { expect, test } from "bun:test";
import { idleNotice } from "../../../src/cli/commands/browser.ts";

test("under a minute the grace is shown in seconds", () => {
  expect(idleNotice(4000)).toContain("closes by itself 4 s after the last tab leaves");
  expect(idleNotice(1)).toContain("1 s after");
  expect(idleNotice(1500)).toContain("2 s after");
  expect(idleNotice(59_000)).toContain("59 s after");
});

test("a minute or more is shown in minutes", () => {
  expect(idleNotice(60_000)).toContain("1 min after");
  expect(idleNotice(5 * 60_000)).toContain("5 min after");
  expect(idleNotice(undefined)).toContain("30 min after");
});

test("0 says it stays until stopped", () => {
  expect(idleNotice(0)).toContain("until you stop it");
});
