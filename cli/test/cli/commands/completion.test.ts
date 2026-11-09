// Shell completion against the Go 0.34.1 oracle: the generated scripts for every shell, their
// --no-descriptions variants and help text, and the hidden __complete protocol (candidates plus
// the `:<directive>` line) for commands, subcommands, flags and flag values.
import { describe, expect, test } from "bun:test";
import { withoutD13 } from "../../helpers/d13.ts";
import { hasGoBin, runGo, runTs } from "../oracle.ts";

const t = test.skipIf(!hasGoBin);

async function same(args: string[], env: Record<string, string> = {}): Promise<void> {
  const go = runGo(args, env);
  const raw = await runTs(args, { env });
  const ts = { ...raw, stdout: withoutD13(raw.stdout) };
  expect(ts).toEqual(go);
}

describe("completion scripts match Go", () => {
  for (const shell of ["bash", "zsh", "fish", "powershell"]) {
    t(`${shell}`, () => same(["completion", shell]));
    t(`${shell} --no-descriptions`, () => same(["completion", shell, "--no-descriptions"]));
    t(`${shell} --help`, () => same(["completion", shell, "--help"]));
    t(`help completion ${shell}`, () => same(["help", "completion", shell]));
  }
  t("completion alone prints its help", () => same(["completion"]));
  t("completion --help", () => same(["completion", "--help"]));
  t("extra argument is rejected", () => same(["completion", "bash", "extra"]));
  t("unknown shell", () => same(["completion", "tcsh"]));
  t("--no-descriptions=false keeps descriptions", () =>
    same(["completion", "zsh", "--no-descriptions=false"]),
  );
  t("root help still lists completion", () => same(["--help"]));
});

describe("__complete protocol matches Go", () => {
  const lines: string[][] = [
    [""],
    ["t"],
    ["ta"],
    ["help", ""],
    ["help", "task", ""],
    ["help", "task", "li"],
    ["help", "nope", ""],
    ["completion", ""],
    ["completion", "b"],
    ["completion", "bash", ""],
    ["completion", "bash", "--"],
    ["completion", "bash", "--no"],
    ["completion", "bash", "-"],
    ["nope", ""],
    ["task", ""],
    ["task", "l"],
    ["task", "list", ""],
    ["task", "list", "-"],
    ["task", "list", "--"],
    ["task", "list", "--s"],
    ["task", "list", "--status"],
    ["task", "list", "--status", ""],
    ["task", "list", "--status="],
    ["task", "list", "--status=do"],
    ["task", "list", "-s", ""],
    ["task", "list", "--plain", "--"],
    ["task", "list", "--plain", ""],
    ["task", "list", "--plain", "--p"],
    ["task", "create", ""],
    ["task", "create", "--"],
    ["task", "create", "--ac", "x", "--a"],
    ["task", "create", "--ac", "x", "--"],
    ["task", "create", "title", "--priority", ""],
    ["task", "edit", "--"],
    ["task", "bogus", ""],
    ["task", "list", "--bogus", ""],
    ["task", "list", "--bogus", "--"],
    ["task", "list", "--help", ""],
    ["task", "list", "--help", "--"],
    ["--", ""],
    ["--"],
    ["-"],
    ["--v"],
    ["--version", ""],
    ["--plain", "t"],
    ["--page", "2", "t"],
    ["--page", ""],
    ["--no-pager", ""],
    ["--no-"],
    ["-h", ""],
    ["task", "list", "--", "-"],
    ["task", "list", "x", ""],
    ["doc", ""],
    ["doc", "list", "--"],
    ["doc", "create", "--"],
    ["memory", "add", "--"],
    ["time", ""],
    ["config", ""],
    ["config", "set", ""],
    ["lsp", "--"],
    ["lsp", "install", "--"],
    ["search", "--"],
    ["search", "x", "--"],
    ["runtime", ""],
    ["runtime", "--"],
    ["runtime", "memory", ""],
    ["runtime", "memory", "hook", "--"],
    ["runtime-memory", ""],
    ["runtime-memory", "hook", "--"],
    ["provider", ""],
    ["provider", "add", "--"],
    ["eval", ""],
    ["eval", "retrieval", "--"],
    ["decision", "--"],
    ["decision", ""],
    ["template", ""],
    ["code", ""],
    ["code", "--"],
    ["store", ""],
    ["store", "sync", "--"],
    ["init", "--"],
    ["status", "--"],
    ["browser", "--"],
    ["agents", ""],
    ["sync", "--"],
    ["validate", "--"],
    ["import", "--"],
    ["update", "--"],
    ["setup", "--"],
    ["tunnel", "--"],
    ["qdrant", ""],
    ["qdrant", "--"],
    ["migrate", "--"],
    ["doctor", "--"],
    ["settings", ""],
    ["settings", "--"],
    ["resolve", "--"],
    ["retrieve", "--"],
    ["reconcile", "--"],
    ["quickstart", "--"],
    ["mcp", "--"],
    ["decision", "migrate", "apply", ""],
    ["decision", "migrate", "apply", "-"],
    ["decision", "migrate", "apply", "--memory", "x", "-"],
    ["decision", "migrate", "apply", "--memory", "x", "--resolution", "y", "--"],
    ["lsp", "install", "--latest", "--"],
    ["lsp", "install", "--version", "1", "--"],
    ["task", "list", "-s="],
    ["task", "list", "-s=do"],
    ["task", "list", "-zs="],
    ["task", "list", "--plain="],
    ["task", "list", "--plain=t"],
    ["__complete", ""],
    ["completion", "zsh", "--no-descriptions", ""],
    ["completion", "zsh", "--no-descriptions", "--"],
  ];
  for (const line of lines) {
    const label = JSON.stringify(line);
    t(`__complete ${label}`, () => same(["__complete", ...line]));
    t(`__completeNoDesc ${label}`, () => same(["__completeNoDesc", ...line]));
  }

  t("no arguments is an error", () => same(["__complete"]));
  t("COBRA_COMPLETION_DESCRIPTIONS=0 drops descriptions", () =>
    same(["__complete", "t"], { COBRA_COMPLETION_DESCRIPTIONS: "0" }),
  );
  t("KNOWNS_COMPLETION_DESCRIPTIONS=false drops descriptions", () =>
    same(["__complete", "t"], { KNOWNS_COMPLETION_DESCRIPTIONS: "false" }),
  );
  t("KNOWNS_COMPLETION_DESCRIPTIONS wins over COBRA_", () =>
    same(["__complete", "t"], {
      KNOWNS_COMPLETION_DESCRIPTIONS: "1",
      COBRA_COMPLETION_DESCRIPTIONS: "0",
    }),
  );
  t("an unparsable description setting is ignored", () =>
    same(["__complete", "t"], { KNOWNS_COMPLETION_DESCRIPTIONS: "maybe" }),
  );
  t("a root flag before __complete still selects it", () => same(["--plain", "__complete", "t"]));
});
