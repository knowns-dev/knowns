// Every hidden root command (the root-help manifest lists them with no summary, because Go's root
// help never prints them) and its subcommands print the same help as 0.34.1, header included.
// Subcommands are discovered from Go itself: its help lists them under "Commands:".
import { describe, expect, test } from "bun:test";
import { ROOT_MANIFEST } from "../../../src/cli/core/help-manifest.generated.ts";
import { hasGoBin, runGo, runTs } from "../oracle.ts";

const hidden = ROOT_MANIFEST.filter((e) => e.hidden).map((e) => e.name);

/** The subcommand names Go's help lists for `path` (styling stripped). */
function goSubcommands(path: string[]): string[] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes is the point
  const text = runGo([...path, "--help"]).stdout.replace(/\x1b\[[0-9;]*m/g, "");
  const out: string[] = [];
  let inCommands = false;
  for (const line of text.split("\n")) {
    if (/^\S.*:$/.test(line)) {
      inCommands = line === "Commands:";
      continue;
    }
    const m = inCommands ? /^ {2}(\S+)\s/.exec(line) : null;
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

describe.skipIf(!hasGoBin)("hidden root commands match Go", () => {
  test("the manifest lists the hidden roots", () => {
    expect(hidden).toEqual(expect.arrayContaining(["__lsp-daemon", "__runtime", "runtime-memory"]));
  });
  const paths: string[][] = [];
  for (const name of hasGoBin ? hidden : []) {
    paths.push([name]);
    for (const sub of goSubcommands([name])) paths.push([name, sub]);
  }
  // Internal subcommands Go hides from its own help.
  if (hasGoBin) paths.push(["__runtime", "run"], ["__runtime", "status"], ["__lsp-daemon", "run"]);
  for (const path of paths) {
    test(`${path.join(" ")} --help`, async () => {
      expect(await runTs([...path, "--help"])).toEqual(runGo([...path, "--help"]));
    });
    test(`help ${path.join(" ")}`, async () => {
      expect(await runTs(["help", ...path])).toEqual(runGo(["help", ...path]));
    });
  }
  for (const name of hasGoBin ? hidden : []) {
    test(`${name} with no subcommand`, async () => {
      expect(await runTs([name])).toEqual(runGo([name]));
    });
  }
});
