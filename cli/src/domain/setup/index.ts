// Setup library: what `knowns init`, `setup`, `sync` and `agents` write, reusable by the MCP and
// server layers. Nothing here imports src/cli.
export * from "./env.ts";
export * from "./gitignore.ts";
export * from "./global.ts";
export * from "./hermes.ts";
export * from "./instruction-files.ts";
export * from "./json-files.ts";
export * from "./lsp-detect.ts";
export * from "./mcp-command.ts";
export * from "./mcp-config.ts";
export * from "./platforms.ts";
export * as runtimeinstall from "./runtimeinstall.ts";
export * from "./yaml.ts";
