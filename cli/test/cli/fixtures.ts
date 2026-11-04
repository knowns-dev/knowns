// Command definitions that mirror real 0.34.1 commands (internal/cli/audit.go and lsp.go), so the
// golden tests can compare commands registered through the framework with the Go originals.
import { exactArgs } from "../../src/cli/core/args.ts";
import { defineCommand } from "../../src/cli/core/define.ts";

const notPorted = (): never => {
  throw new Error("handler is not part of the framework golden tests");
};

export const auditSpec = defineCommand({
  use: "audit",
  short: "Inspect MCP tool call audit trail",
  subcommands: [
    defineCommand({
      use: "recent",
      short: "Show recent MCP tool calls",
      flags: [
        { type: "int", name: "limit", usage: "Maximum number of events to show", default: 50 },
        { type: "string", name: "tool", usage: "Filter by tool name" },
        { type: "string", name: "result", usage: "Filter by result (success, error, denied)" },
        { type: "string", name: "project", usage: "Filter by project root path" },
      ],
      run: notPorted,
    }),
    defineCommand({
      use: "stats",
      short: "Show MCP tool call statistics",
      flags: [
        { type: "string", name: "tool", usage: "Filter by tool name" },
        { type: "string", name: "project", usage: "Filter by project root path" },
      ],
      run: notPorted,
    }),
  ],
});

export const lspSpec = defineCommand({
  use: "lsp",
  short: "Manage LSP language servers",
  subcommands: [
    defineCommand({
      use: "list",
      short: "List supported LSP language servers",
      flags: [
        {
          type: "bool",
          name: "verbose",
          shorthand: "v",
          usage: "Show daemon owner, backend selection, and log paths",
        },
      ],
      run: notPorted,
    }),
    defineCommand({
      use: "install <language>",
      short: "Install an LSP language server",
      args: exactArgs(1),
      flags: [
        {
          type: "bool",
          name: "latest",
          usage: "Install the latest upstream version (requires confirmation)",
        },
        {
          type: "string",
          name: "version",
          usage: "Install an explicit upstream version or tag (requires confirmation)",
        },
        {
          type: "bool",
          name: "yes",
          shorthand: "y",
          usage: "Confirm a non-recommended version selection",
        },
      ],
      flagGroups: { mutuallyExclusive: [["latest", "version"]] },
      run: notPorted,
    }),
    defineCommand({ use: "cleanup", short: "Remove old LSP server versions", run: notPorted }),
  ],
});
