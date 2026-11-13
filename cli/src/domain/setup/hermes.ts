// Port of internal/cli/hermes.go: the Hermes Agent config (~/.hermes/config.yaml) gets the knowns
// MCP server and the skills directory, merged into whatever the user already has.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Env, userHomeDir } from "./env.ts";
import { mcpCommand } from "./mcp-command.ts";
import { marshalYaml, unmarshalYaml } from "./yaml.ts";

type Obj = Record<string, unknown>;

const mapValue = (config: Obj, key: string): Obj => {
  const v = config[key];
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
};

const anyStringSlice = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const appendUnique = (values: string[], value: string): string[] =>
  values.includes(value) ? values : [...values, value];

function readYamlConfig(path: string): Obj | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    return unmarshalYaml(text);
  } catch (e) {
    throw new Error(`parse hermes config.yaml: ${(e as Error).message}`);
  }
}

/** upsertHermesConfig. An empty projectRoot leaves the MCP args unpinned (global setup). */
export function upsertHermesConfig(
  configPath: string,
  skillsDir: string,
  projectRoot: string,
  env: Env = process.env,
): void {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o755 });
  const config = readYamlConfig(configPath) ?? {};
  const { command, args } = mcpCommand(env);
  const finalArgs = projectRoot !== "" ? [...args, "--project", projectRoot] : args;
  const servers = mapValue(config, "mcp_servers");
  servers.knowns = { command, args: finalArgs };
  config.mcp_servers = servers;
  const skills = mapValue(config, "skills");
  skills.external_dirs = appendUnique(anyStringSlice(skills.external_dirs), skillsDir);
  config.skills = skills;
  writeFileSync(configPath, marshalYaml(config), { mode: 0o644 });
}

/** createHermesMCPConfigQuiet. */
export function createHermesMcpConfig(projectRoot: string, env: Env = process.env): void {
  let home: string;
  try {
    home = userHomeDir(env);
  } catch (e) {
    throw new Error(`resolve user home: ${(e as Error).message}`);
  }
  upsertHermesConfig(
    join(home, ".hermes", "config.yaml"),
    join(projectRoot, ".agents", "skills"),
    projectRoot,
    env,
  );
}

/** setupGlobalHermesMCP. */
export function setupGlobalHermesMcp(home: string, env: Env = process.env): void {
  upsertHermesConfig(
    join(home, ".hermes", "config.yaml"),
    join(home, ".agents", "skills"),
    "",
    env,
  );
}

/** syncHermesMCPConfig: refresh an existing config; returns the number of files synced (0 or 1). */
export function syncHermesMcpConfig(
  projectRoot: string,
  env: Env,
  cmd: string,
  args: string[],
  log: (label: string) => void,
): number {
  const configPath = join(userHomeDir(env), ".hermes", "config.yaml");
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return 0;
  }
  const config = unmarshalYaml(text);
  const expectedArgs = [...args, "--project", projectRoot];
  const skillsDir = join(projectRoot, ".agents", "skills");
  const servers = mapValue(config, "mcp_servers");
  const knowns = mapValue(servers, "knowns");
  const skills = mapValue(config, "skills");
  const current = anyStringSlice(skills.external_dirs);
  const next = appendUnique(current, skillsDir);
  const currentArgs = anyStringSlice(knowns.args);
  const changed =
    knowns.command !== cmd ||
    currentArgs.length !== expectedArgs.length ||
    currentArgs.some((a, i) => a !== expectedArgs[i]) ||
    next.length !== current.length;
  if (!changed) return 0;
  knowns.command = cmd;
  knowns.args = expectedArgs;
  servers.knowns = knowns;
  config.mcp_servers = servers;
  skills.external_dirs = next;
  config.skills = skills;
  writeFileSync(configPath, marshalYaml(config), { mode: 0o644 });
  log("~/.hermes/config.yaml");
  return 1;
}
