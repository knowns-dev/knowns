// config get / set / list / reset against the Go 0.34.1 oracle, byte-for-byte on output and on the
// resulting .knowns tree (config.json and the generated .gitignore).
//
// Not covered here: `settings` (interactive huh forms) is not ported.
import { describe, expect, test } from "bun:test";
import {
  formatConfigValue,
  goUnmarshalMismatch,
  normalizedSemanticProvider,
  parseConfigValue,
  resolveConfigSetKey,
} from "../../../src/cli/commands/config.ts";
import { hasGoBin, writeFixtureText } from "./search-harness.ts";
import { expectParity } from "./search-parity.ts";

const cases = hasGoBin ? describe : describe.skip;

cases("config get matches Go", () => {
  const keys = [
    "name",
    "id",
    "createdAt",
    "settings",
    "settings.defaultPriority",
    "defaultPriority",
    "defaultAssignee",
    "settings.statuses",
    "statuses",
    "settings.gitTracking",
    "gitTracking.docs",
    "settings.serverPort",
    "serverPort",
    "settings.taskLifecycle",
    "settings.taskLifecycle.purgeAfter",
    "schemaVersion",
    "nope",
    "settings.nope",
    "settings.statuses.0",
    "",
  ];
  for (const key of keys) {
    test(`get ${JSON.stringify(key)}`, async () => {
      await expectParity("full", [
        ["config", "get", key],
        ["config", "get", key, "--plain"],
        ["config", "get", key, "--json"],
      ]);
    });
  }

  test("usage errors", async () => {
    await expectParity("full", [
      ["config", "get"],
      ["config", "get", "a", "b"],
      ["config", "get", "--help"],
      ["config", "--help"],
      ["config"],
      ["help", "config"],
      ["config", "bogus"],
    ]);
    await expectParity("", [
      ["config", "get", "name"],
      ["config", "list"],
    ]);
  });
});

cases("config list matches Go", () => {
  test("full and empty projects in every mode", async () => {
    for (const fixture of ["full", "empty"]) {
      await expectParity(fixture, [
        ["config", "list"],
        ["config", "list", "--plain"],
        ["config", "list", "--json"],
      ]);
    }
  });

  test("semantic search and one LSP language configured", async () => {
    await expectParity("full", [
      ["config", "set", "semanticSearch", "true"],
      ["config", "set", "settings.semanticSearch.model", "m"],
      ["config", "set", "settings.semanticSearch.provider", "ollama"],
      ["config", "set", "lsp", "false"],
      ["config", "set", "lsp.go", "true"],
      ["config", "set", "settings.lsp.languages.go.binary", "gopls"],
      ["config", "set", "settings.lsp.languages.go.backend", "gopls"],
      ["config", "set", "settings.lsp.languages.go.projectPath", "sub"],
      ["config", "list"],
      ["config", "list", "--plain"],
      ["config", "list", "--json"],
    ]);
  });
});

cases("config set matches Go", () => {
  const sets: Array<[string, string]> = [
    ["defaultPriority", "high"],
    ["settings.defaultPriority", "low"],
    ["defaultAssignee", "@me"],
    ["defaultTaskIdPrefix", "zz"],
    ["defaultTaskIdPrefix", "not valid!"],
    ["serverPort", "7000"],
    ["serverPort", "7000.5"],
    ["serverPort", "abc"],
    ["serverPort", "true"],
    ["serverPort", "99999999999999999999"],
    ["timeFormat", "12h"],
    ["editor", "5"],
    ["lsp", "true"],
    ["lsp", "maybe"],
    ["lsp.go", "false"],
    ["lsp.go.enabled", "true"],
    ["embedding", "true"],
    ["semanticSearch", "false"],
    ["gitTrackingMode", "git-ignored"],
    ["gitTrackingMode", "none"],
    ["settings.gitTracking.docs", "false"],
    ["settings.gitTracking.tasks", "false"],
    ["settings.gitTracking.memories", "true"],
    ["name", "renamed"],
    ["id", "renamed-id"],
    ["a.b.c", "1e3"],
    ["x", "inf"],
    ["x", "-Inf"],
    ["x", "NaN"],
    ["x", "9223372036854775807"],
    ["x", "9223372036854775808"],
    ["x", "+5"],
    ["x", "-0"],
    ["x", "1_0"],
    ["x", "0x10"],
    ["x", "1.50"],
    ["x", "1e400"],
    ["x", "TRUE"],
    ["x", "t"],
    ["x", "False"],
    ["x", "yes"],
    ["x", ""],
    ["statuses", "todo"],
    ["platforms", "claude-code"],
  ];
  for (const [key, value] of sets) {
    test(`set ${key} ${JSON.stringify(value)}`, async () => {
      await expectParity("full", [
        ["config", "set", key, value],
        ["config", "get", key],
        ["config", "list", "--plain"],
      ]);
    });
  }

  test("gitTracking regenerates .knowns/.gitignore for every mode", async () => {
    await expectParity("full", [
      ["config", "set", "settings.gitTracking.docs", "false"],
      ["config", "set", "settings.gitTracking.tasks", "false"],
      ["config", "set", "settings.gitTracking.templates", "false"],
      ["config", "set", "settings.gitTracking.memories", "true"],
      ["config", "set", "settings.gitTracking.decisions", "false"],
      ["config", "set", "gitTrackingMode", "git-ignored"],
      ["config", "set", "settings.gitTracking.docs", "true"],
      ["config", "set", "gitTrackingMode", "none"],
      ["config", "set", "settings.gitTracking.docs", "false"],
    ]);
  });

  test("gitTracking removes the legacy marker block from the root .gitignore", async () => {
    await expectParity("full", [["config", "set", "settings.gitTracking.docs", "false"]], {
      setup: (dir) => {
        writeFixtureText(
          dir,
          ".gitignore",
          "node_modules\n# >>> KNOWNS >>>\n.knowns/x\n# <<< KNOWNS <<<\ndist\n",
        );
      },
    });
  });

  test("usage errors", async () => {
    await expectParity("full", [
      ["config", "set"],
      ["config", "set", "only"],
      ["config", "set", "a", "b", "c"],
      ["config", "set", "--help"],
    ]);
    await expectParity("", [["config", "set", "a", "b"]]);
  });
});

cases("config reset matches Go", () => {
  test("--yes in every mode", async () => {
    await expectParity("full", [
      ["config", "set", "defaultPriority", "high"],
      ["config", "reset", "--yes"],
      ["config", "list", "--json"],
    ]);
    await expectParity("full", [
      ["config", "reset", "-y", "--json"],
      ["config", "get", "name"],
    ]);
    await expectParity("full", [["config", "reset", "-y", "--plain"]]);
  });

  test("the prompt: yes, y, no, anything else, and EOF", async () => {
    for (const answer of ["y\n", "yes\n", "n\n", "no\n", "maybe\n", "Y\n", "", "  y  \n"]) {
      await expectParity("full", [{ args: ["config", "reset"], stdin: answer }]);
    }
  });

  test("an empty project", async () => {
    await expectParity("empty", [
      ["config", "reset", "--yes"],
      ["config", "list", "--plain"],
    ]);
  });

  test("usage errors", async () => {
    await expectParity("full", [
      ["config", "reset", "--bogus"],
      ["config", "reset", "extra", "--yes"],
      ["config", "reset", "--help"],
    ]);
  });
});

describe("config helpers", () => {
  test("provider normalisation (ollama-only D1)", () => {
    expect(normalizedSemanticProvider("")).toBe("ollama");
    expect(normalizedSemanticProvider("local")).toBe("ollama");
    expect(normalizedSemanticProvider("api")).toBe("api");
  });

  test("value parsing: int, float, bool, then string", () => {
    expect(parseConfigValue("12")).toBe(12);
    expect(parseConfigValue("-3")).toBe(-3);
    expect(parseConfigValue("1.5")).toBe(1.5);
    expect(parseConfigValue("1e3")).toBe(1000);
    expect(parseConfigValue("true")).toBe(true);
    expect(parseConfigValue("F")).toBe(false);
    expect(parseConfigValue("1")).toBe(1);
    expect(parseConfigValue("0x10")).toBe("0x10");
    // strconv accepts the underscore here, so Go stores 10
    expect(parseConfigValue("1_0")).toBe(10);
    expect(parseConfigValue("hello")).toBe("hello");
    expect(JSON.stringify(parseConfigValue("9223372036854775807"))).toBe("9223372036854775807");
  });

  test("key shorthands", () => {
    expect(resolveConfigSetKey("lsp")).toBe("settings.lsp.enabled");
    expect(resolveConfigSetKey("lsp.go")).toBe("settings.lsp.languages.go.enabled");
    expect(resolveConfigSetKey("lsp.go.x")).toBe("lsp.go.x");
    expect(resolveConfigSetKey("embedding")).toBe("settings.semanticSearch.enabled");
    expect(resolveConfigSetKey("semanticSearch")).toBe("settings.semanticSearch.enabled");
    expect(resolveConfigSetKey("name")).toBe("name");
    expect(resolveConfigSetKey("id")).toBe("id");
    expect(resolveConfigSetKey("serverPort")).toBe("settings.serverPort");
    expect(resolveConfigSetKey("a.b")).toBe("a.b");
  });

  test("Go's type errors for the directly typed fields", () => {
    expect(goUnmarshalMismatch("settings.serverPort", "abc", "abc")).toBe(
      "json: cannot unmarshal string into Go struct field ProjectSettings.settings.serverPort of type int",
    );
    expect(goUnmarshalMismatch("settings.serverPort", 7000.5, "7000.5")).toBe(
      "json: cannot unmarshal number 7000.5 into Go struct field ProjectSettings.settings.serverPort of type int",
    );
    expect(goUnmarshalMismatch("settings.serverPort", 7000, "7000")).toBe("");
    expect(goUnmarshalMismatch("settings.editor", 5, "5")).toContain("of type string");
    expect(goUnmarshalMismatch("settings.unknown", 5, "5")).toBe("");
  });

  test("formatting of values", async () => {
    expect(await formatConfigValue(null)).toBe("");
    expect(await formatConfigValue("s")).toBe("s");
    expect(await formatConfigValue(true)).toBe("true");
    expect(await formatConfigValue(7)).toBe("7");
    expect(await formatConfigValue(["a", 1, false])).toBe("a, 1, false");
    expect(await formatConfigValue({ b: 1, a: "<x>" })).toBe('{"a":"\\u003cx\\u003e","b":1}');
    expect(await formatConfigValue(JSON.rawJSON("1.0"))).toBe("1.0");
  });
});
