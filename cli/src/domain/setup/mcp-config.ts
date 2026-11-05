// The project-level platform config writers of internal/cli/init.go, and the "point an existing
// config at the current binary" syncs of internal/cli/update.go (syncMCPConfigs). Every writer
// takes an Env so the PATH lookup (`knowns` or the npx fallback) and HOME come from the run.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Env, userHomeDir } from "./env.ts";
import { syncHermesMcpConfig } from "./hermes.ts";
import {
  isMap,
  type JsonMap,
  marshalMap,
  readJsonMap,
  readTextIfExists,
  writeJsonMap,
} from "./json-files.ts";
import { mcpCommand, mcpCommandFlat } from "./mcp-command.ts";
import { setCodexMcpServer } from "./runtimeinstall.ts";

function mkdirp(dir: string, what?: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
  } catch (e) {
    throw what ? new Error(`create ${what}: ${(e as Error).message}`) : e;
  }
}

function readParsed(path: string, label: string): JsonMap {
  try {
    return readJsonMap(path);
  } catch (e) {
    throw new Error(`parse ${label}: ${(e as Error).message}`);
  }
}

/** createMCPJsonFileQuiet: .mcp.json, left alone when present unless forced (no trailing newline). */
export function createMcpJsonFile(
  projectRoot: string,
  force: boolean,
  env: Env = process.env,
): void {
  const path = join(projectRoot, ".mcp.json");
  if (existsSync(path) && !force) return;
  const { command, args } = mcpCommand(env);
  writeFileSync(path, marshalMap({ mcpServers: { knowns: { command, args } } }), { mode: 0o644 });
}

/** createOpenCodeConfigQuiet: merge the knowns server into opencode.json. */
export function createOpenCodeConfig(projectRoot: string, env: Env = process.env): void {
  const path = join(projectRoot, "opencode.json");
  const config: JsonMap = { $schema: "https://opencode.ai/config.json" };
  Object.assign(config, readParsed(path, "opencode.json"));
  config.$schema = "https://opencode.ai/config.json";
  const mcp = isMap(config.mcp) ? config.mcp : {};
  mcp.knowns = { type: "local", command: mcpCommandFlat(env), enabled: true };
  config.mcp = mcp;
  writeJsonMap(path, config);
}

const KIRO_STEERING = `---
description: Knowns project guidelines — prefer MCP initial/help and Knowns tools.
---

# Knowns Guidelines

Start with Knowns MCP \`initial\` when available. Use \`help("tool.*")\` or \`help("workflow.*")\` for domain details on demand.

Use Knowns docs, tasks, search, memory, and validation as the project working layer. If MCP is unavailable, use the \`knowns\` CLI for project context.
`;

/** createKiroSteeringQuiet: .kiro/steering/knowns.md. */
export function createKiroSteering(projectRoot: string, force: boolean): void {
  const dir = join(projectRoot, ".kiro", "steering");
  mkdirp(dir, ".kiro/steering");
  const path = join(dir, "knowns.md");
  if (existsSync(path) && !force) return;
  writeFileSync(path, KIRO_STEERING, { mode: 0o644 });
}

/** createKiroMCPConfigQuiet: merge the knowns server into .kiro/settings/mcp.json. */
export function createKiroMcpConfig(projectRoot: string, env: Env = process.env): void {
  const dir = join(projectRoot, ".kiro", "settings");
  mkdirp(dir, ".kiro/settings");
  const path = join(dir, "mcp.json");
  const config = readParsed(path, ".kiro/settings/mcp.json");
  const servers = isMap(config.mcpServers) ? config.mcpServers : {};
  const { command, args } = mcpCommand(env);
  servers.knowns = { command, args, disabled: false, autoApprove: ["*"] };
  config.mcpServers = servers;
  writeJsonMap(path, config);
}

/** createCursorMCPConfigQuiet: merge the knowns server into .cursor/mcp.json. */
export function createCursorMcpConfig(projectRoot: string, env: Env = process.env): void {
  const dir = join(projectRoot, ".cursor");
  mkdirp(dir, ".cursor");
  const path = join(dir, "mcp.json");
  const config = readParsed(path, ".cursor/mcp.json");
  const servers = isMap(config.mcpServers) ? config.mcpServers : {};
  const { command, args } = mcpCommand(env);
  servers.knowns = { command, args };
  config.mcpServers = servers;
  writeJsonMap(path, config);
}

/** createCodexMCPConfigQuiet: the [mcp_servers.knowns] section of .codex/config.toml. */
export function createCodexMcpConfig(projectRoot: string, env: Env = process.env): void {
  const dir = join(projectRoot, ".codex");
  mkdirp(dir, ".codex");
  const path = join(dir, "config.toml");
  const body = readTextIfExists(path);
  const { command, args } = mcpCommand(env);
  writeFileSync(path, setCodexMcpServer(body, command, args), { mode: 0o644 });
}

const ANTIGRAVITY_RULES = `---
trigger: always_on
description: Prefer Knowns MCP initial/help and Knowns tools for project context.
---

# Knowns Project Guidance

- Start with Knowns MCP \`initial\` when available.
- Use \`help("tool.*")\` or \`help("workflow.*")\` for domain details on demand.
- Treat Knowns docs, tasks, and memory as the working layer for the project.
- Prefer Knowns MCP tools for docs, tasks, search, and validation when available.
- If MCP is unavailable, fall back to the \`knowns\` CLI.
`;

/** createAntigravityRulesQuiet: .agents/rules/knowns.md. */
export function createAntigravityRules(projectRoot: string, force: boolean): void {
  const dir = join(projectRoot, ".agents", "rules");
  mkdirp(dir, ".agents/rules");
  const path = join(dir, "knowns.md");
  if (existsSync(path) && !force) return;
  writeFileSync(path, ANTIGRAVITY_RULES, { mode: 0o644 });
}

/** createAntigravityMCPConfigQuiet: ~/.gemini/antigravity/mcp_config.json pinned to the project. */
export function createAntigravityMcpConfig(projectRoot: string, env: Env = process.env): void {
  let home: string;
  try {
    home = userHomeDir(env);
  } catch (e) {
    throw new Error(`resolve user home: ${(e as Error).message}`);
  }
  const dir = join(home, ".gemini", "antigravity");
  mkdirp(dir, "antigravity config dir");
  const path = join(dir, "mcp_config.json");
  const config = readParsed(path, "antigravity mcp_config.json");
  const servers = isMap(config.mcpServers) ? config.mcpServers : {};
  const { command, args } = mcpCommand(env);
  servers.knowns = { command, args: [...args, "--project", projectRoot] };
  config.mcpServers = servers;
  writeJsonMap(path, config);
}

// --- syncMCPConfigs (internal/cli/update.go) ----------------------------------------------------

function readJsonIfPresent(path: string): JsonMap | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const v: unknown = JSON.parse(text);
  return isMap(v) ? v : undefined;
}

const sameStrings = (values: unknown, expected: string[]): boolean =>
  Array.isArray(values) &&
  values.length === expected.length &&
  expected.every((e, i) => values[i] === e);

function syncJsonServer(
  path: string,
  label: string,
  parent: "mcpServers" | "mcp",
  update: (knowns: JsonMap) => boolean,
  newline: boolean,
  log: (line: string) => void,
): number {
  const config = readJsonIfPresent(path);
  if (!config) return 0;
  const servers = config[parent];
  if (!isMap(servers) || !isMap(servers.knowns)) return 0;
  if (!update(servers.knowns)) return 0;
  writeFileSync(path, marshalMap(config) + (newline ? "\n" : ""), { mode: 0o644 });
  log(label);
  return 1;
}

/**
 * syncMCPConfigs without the project walk: rewrite every existing platform config that does not
 * already use `command`. `log` receives the label of each synced file (Go prints "  synced <label>").
 */
export function syncMcpConfigs(
  projectRoot: string,
  env: Env,
  log: (label: string) => void,
): number {
  const { command: cmd, args } = mcpCommand(env);
  let updated = 0;
  const attempt = (fn: () => number): void => {
    try {
      updated += fn();
    } catch {
      // Go ignores the error of each individual sync.
    }
  };
  const basic = (path: string, label: string, newline: boolean): number =>
    syncJsonServer(
      path,
      label,
      "mcpServers",
      (k) => {
        if (k.command === cmd) return false;
        k.command = cmd;
        k.args = args;
        return true;
      },
      newline,
      log,
    );

  attempt(() => basic(join(projectRoot, ".mcp.json"), ".mcp.json", false));
  attempt(() =>
    basic(join(projectRoot, ".kiro", "settings", "mcp.json"), ".kiro/settings/mcp.json", true),
  );
  attempt(() => basic(join(projectRoot, ".cursor", "mcp.json"), ".cursor/mcp.json", true));
  attempt(() => {
    const path = join(projectRoot, ".codex", "config.toml");
    const body = readTextIfExists(path);
    if (body === "") return 0;
    const next = setCodexMcpServer(body, cmd, args);
    if (next === body) return 0;
    writeFileSync(path, next, { mode: 0o644 });
    log(".codex/config.toml");
    return 1;
  });
  attempt(() => {
    const path = join(userHomeDir(env), ".gemini", "antigravity", "mcp_config.json");
    const expected = [...args, "--project", projectRoot];
    return syncJsonServer(
      path,
      "~/.gemini/antigravity/mcp_config.json",
      "mcpServers",
      (k) => {
        if (k.command === cmd && sameStrings(k.args, expected)) return false;
        k.command = cmd;
        k.args = expected;
        return true;
      },
      true,
      log,
    );
  });
  attempt(() => syncHermesMcpConfig(projectRoot, env, cmd, args, log));
  attempt(() =>
    syncJsonServer(
      join(projectRoot, "opencode.json"),
      "opencode.json",
      "mcp",
      (k) => {
        const existing = k.command;
        if (Array.isArray(existing) && existing.length > 0 && existing[0] === cmd) return false;
        k.command = [cmd, ...args];
        return true;
      },
      true,
      log,
    ),
  );
  return updated;
}

export { mcpCommand, mcpCommandFlat };
