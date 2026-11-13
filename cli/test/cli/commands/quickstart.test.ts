// quickstart against the Go 0.34.1 oracle.
import { describe, expect, test } from "bun:test";
import {
  quickstartColumn,
  quickstartGroups,
  renderQuickstart,
} from "../../../src/cli/commands/quickstart.ts";
import { hasGoBin } from "./search-harness.ts";
import { expectParity } from "./search-parity.ts";

const cases = hasGoBin ? describe : describe.skip;

cases("quickstart matches Go", () => {
  test("every output mode, with and without a project", async () => {
    for (const fixture of ["full", ""]) {
      await expectParity(fixture, [
        ["quickstart"],
        ["quickstart", "--plain"],
        ["quickstart", "--json"],
        ["quickstart", "extra"],
        ["quickstart", "--bogus"],
        ["quickstart", "--help"],
        ["help", "quickstart"],
      ]);
    }
  });
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI styling is part of the output
const stripAnsi = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, "");

describe("quickstart layout", () => {
  test("aligns described commands to the widest one under the cap", () => {
    const text = stripAnsi(
      renderQuickstart([
        {
          title: "T",
          entries: [
            { cmd: "a", desc: "short" },
            { cmd: "abcd", desc: "longer" },
            { cmd: "x".repeat(60), desc: "too wide: own line" },
            { cmd: "bare" },
          ],
        },
      ]),
    );
    expect(text).toContain("  a     short\n");
    expect(text).toContain("  abcd  longer\n");
    expect(text).toContain(`  ${"x".repeat(60)}\n  ${" ".repeat(6)}too wide: own line\n`);
    expect(text).toContain("  bare\n");
  });

  test("a group with only undescribed entries has no column", () => {
    expect(quickstartColumn([{ cmd: "knowns task list" }])).toBe(0);
    expect(quickstartColumn(quickstartGroups[2]?.entries ?? [])).toBe(0);
  });
});
