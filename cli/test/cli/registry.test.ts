// The root-help manifest and the loader registry: what is listed, what is ported, and the gates
// that keep them honest.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandLoaders } from "../../src/cli/commands/index.ts";
import { ROOT_MANIFEST } from "../../src/cli/core/help-manifest.generated.ts";
import { groupRootCommands, HELP_GROUPS } from "../../src/cli/core/helpgroups.ts";
import { REMOVED_COMMAND_SHORT } from "../../src/cli/core/removed.ts";
import { createRoot } from "../../src/cli/core/root.ts";
import { GO_BIN, hasGoBin } from "./oracle.ts";

describe("manifest", () => {
  test("is sorted and unique", () => {
    const names = ROOT_MANIFEST.map((e) => e.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  test("every visible command is in a help group (Go's TestHelpGroupsCoverAllCommands)", () => {
    const grouped = new Set(HELP_GROUPS.flatMap((g) => g.commands));
    const visible = ROOT_MANIFEST.filter((e) => !e.hidden).map((e) => e.name);
    expect(visible.filter((n) => !grouped.has(n))).toEqual([]);
    expect(groupRootCommands(createRoot()).some((g) => g.title === "Other")).toBe(false);
  });

  test.skipIf(!hasGoBin)("is current with the Go binary and its command contract", () => {
    const out = join(mkdtempSync(join(tmpdir(), "knowns-manifest-")), "manifest.ts");
    const r = Bun.spawnSync(["bun", "scripts/capture-help-manifest.ts", "--out", out], {
      cwd: join(import.meta.dir, "..", ".."),
      env: { ...process.env, KNOWNS_GO_BIN: GO_BIN ?? "" },
    });
    expect(r.exitCode).toBe(0);
    const committed = readFileSync(
      join(import.meta.dir, "..", "..", "src/cli/core/help-manifest.generated.ts"),
      "utf8",
    );
    expect(readFileSync(out, "utf8")).toBe(committed);
  });
});

describe("loader registry", () => {
  test("every ported command agrees with the manifest", async () => {
    for (const [name, loader] of Object.entries(commandLoaders)) {
      const spec = (await loader.load()).default;
      expect(spec.use.split(" ")[0]).toBe(name);
      const entry = ROOT_MANIFEST.find((e) => e.name === name);
      if (entry) {
        // The manifest is what root help prints; the ported command must say the same.
        expect({ name, short: spec.short, hidden: spec.hidden ?? false }).toEqual({
          name,
          short: REMOVED_COMMAND_SHORT[name] ?? entry.short,
          hidden: entry.hidden,
        });
      } else {
        // A TS-only command must declare how root help lists it before its module loads.
        expect(loader.short).toBe(spec.short);
      }
    }
  });
});

describe("tree", () => {
  test("lists exactly the 0.34.1 root commands plus cobra's help and completion", () => {
    const names = createRoot()
      .commands()
      .map((c) => c.name());
    expect(names.sort()).toEqual([...ROOT_MANIFEST.map((e) => e.name), "completion"].sort());
  });
});
