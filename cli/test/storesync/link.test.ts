import { describe, expect, test } from "bun:test";
import { storeNameFromRemote } from "../../src/domain/storesync/link.ts";

// Mirrors Go TestStoreNameFromRemote (internal/cli/store_cmd_test.go).
describe("storeNameFromRemote", () => {
  const cases: Record<string, string> = {
    "git@github.com:knowns-dev/knowns-tasks.git": "knowns-tasks",
    "https://gitlab.com/team/knowledge": "knowledge",
    "https://gitlab.com/team/knowledge/": "knowledge",
    "/srv/git/team.git": "team",
    "C:\\srv\\git\\team.git": "team",
    "C:\\srv\\git\\team\\": "team",
  };
  for (const [remote, want] of Object.entries(cases)) {
    test(remote, () => expect(storeNameFromRemote(remote)).toBe(want));
  }
});
