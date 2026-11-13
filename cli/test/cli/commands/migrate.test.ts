// `knowns migrate` against the Go 0.34.1 oracle: stdout, stderr, exit code and the config tree.
import { describe, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasGoBin } from "./search-harness.ts";
import { expectParity } from "./search-parity.ts";

const cases = hasGoBin ? describe : describe.skip;

const LEGACY = `{"name":"legacy","id":"legacy","settings":{"defaultPriority":"medium","statuses":["todo","done"],"semanticSearch":{"enabled":true,"provider":"local","model":"multilingual-e5-small","huggingFaceId":"Xenova/multilingual-e5-small","dimensions":384,"maxTokens":512}}}`;
const NO_SEMANTIC = `{"name":"plain","id":"plain","settings":{"defaultPriority":"medium","statuses":["todo","done"]}}`;

const withConfig = (text: string) => (dir: string) => {
  mkdirSync(join(dir, ".knowns"), { recursive: true });
  writeFileSync(join(dir, ".knowns", "config.json"), text);
};

cases("migrate matches Go", () => {
  test("current project: nothing to migrate", async () => {
    await expectParity("full", [
      ["migrate"],
      ["migrate", "--json"],
      ["migrate", "--write"],
      ["migrate", "--write", "--json"],
    ]);
  });

  test("legacy local provider: preview, write, rewrite", async () => {
    await expectParity(
      "empty",
      [
        ["migrate"],
        ["migrate", "--json"],
        ["migrate", "--plain"],
        ["migrate", "--write"],
        ["migrate"],
        ["migrate", "--write", "--json"],
      ],
      { setup: withConfig(LEGACY) },
    );
  });

  test("legacy json write", async () => {
    await expectParity("empty", [["migrate", "--write", "--json"]], { setup: withConfig(LEGACY) });
  });

  test("version-only migration (no semanticSearch block)", async () => {
    await expectParity(
      "empty",
      [["migrate"], ["migrate", "--json"], ["migrate", "--write"], ["migrate", "--write"]],
      { setup: withConfig(NO_SEMANTIC) },
    );
  });

  test("usage and no project", async () => {
    await expectParity("full", [
      ["migrate", "extra"],
      ["migrate", "--bogus"],
      ["migrate", "--help"],
      ["help", "migrate"],
    ]);
    await expectParity("", [["migrate"], ["migrate", "--write"]]);
  });
});
