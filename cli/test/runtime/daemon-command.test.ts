// The runtime and LSP daemons re-run this program with `__runtime run` / `__lsp-daemon run`. A
// compiled binary must not pass its embedded entry path as an argument, or the child parses it as
// an unknown command and exits (seen on Windows, where Bun reports B:/~BUN/root/bin.js).
// daemonCommand itself is overridden by the test preload, so the decision is tested here directly.
import { describe, expect, test } from "bun:test";
import { isCompiledEntry } from "../../src/runtime/queue.ts";

describe("isCompiledEntry", () => {
  test("recognises compiled entries on every platform", () => {
    for (const s of [
      "",
      "/$bunfs/root/bin.js",
      "B:/~BUN/root/bin.js",
      "B:\\~BUN\\root\\bin.js",
      "b:/~BUN/root/bin.js",
    ]) {
      expect(isCompiledEntry(s)).toBe(true);
    }
  });
  test("leaves scripts on disk alone", () => {
    for (const s of [
      "/Users/me/knowns/cli/src/bin.ts",
      "C:\\Users\\me\\knowns\\cli\\src\\bin.ts",
      "C:/Users/me/~BUNNY/bin.ts",
      "/tmp/$bunfs-like/bin.ts",
    ]) {
      expect(isCompiledEntry(s)).toBe(false);
    }
  });
});
