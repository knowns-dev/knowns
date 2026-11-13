// Port of internal/runtimeinstall/runtimeinstall.go: install, uninstall and report the runtime
// memory hooks of Claude Code, Codex, Kiro and OpenCode. Paths and file bytes match Go; the
// executable recorded in a hook is Options.executablePath (os.Executable() there).
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Env, lookPath, userHomeDir } from "./env.ts";
import { isMap, type JsonMap, readJsonMap, readTextIfExists, writeJsonMap } from "./json-files.ts";

export const STATE_INSTALLED = "installed";
export const STATE_MISSING = "missing";
export const STATE_DRIFTED = "drifted";
export const STATE_MISCONFIGURED = "misconfigured";
export const HOOK_KIND_NATIVE = "native-hooks";
export const HOOK_KIND_PLUGIN = "plugin";

const MANAGED_NAME = "knowns-runtime-memory";
const MANAGED_STATUS = "Knowns runtime memory";
const PLUGIN_FILE_NAME = "knowns-runtime-memory.js";
const CLAUDE_SETTINGS = "settings.json";
const CODEX_HOOKS_FILE = "hooks.json";
const CODEX_CONFIG = "config.toml";
const KIRO_MCP_CONFIG = "mcp.json";
const OPENCODE_CONFIG = "opencode.json";
const DEFAULT_HOOK_EVENT = "user-prompt-submit";

const norm = (s: string) => s.trim().toLowerCase();

function runtimeHookEvent(runtime: string): string {
  switch (norm(runtime)) {
    case "kiro":
      return "promptsubmit";
    case "opencode":
      return "session.created";
    default:
      return DEFAULT_HOOK_EVENT;
  }
}

function baselineHookEvent(runtime: string): string {
  return norm(runtime) === "opencode" ? "session.created" : "session-start";
}

function nativeBaselineHookKey(runtime: string): string | undefined {
  const r = norm(runtime);
  return r === "claude-code" || r === "codex" ? "SessionStart" : undefined;
}

function nativePromptHookKey(runtime: string): string {
  const r = norm(runtime);
  return r === "claude-code" || r === "codex" ? "UserPromptSubmit" : "";
}

export interface Options {
  homeDir: string;
  executablePath: string;
  /** Resolves a binary on PATH; undefined when absent. */
  lookPath?: (name: string) => string | undefined;
  goos: string;
  /** The working directory Kiro's workspace hook lives under (os.Getwd() in Go). */
  cwd: string;
}

export interface Status {
  runtime: string;
  displayName: string;
  hookKind: string;
  available: boolean;
  installed: boolean;
  state: string;
  summary: string;
  paths?: string[];
  details?: string[];
}

interface RuntimeSpec {
  runtime: string;
  displayName: string;
  hookKind: string;
  binary: string;
  artifact: string;
}

/** DefaultOptions: the home, executable and PATH of this run. */
export function defaultOptions(env: Env = process.env, cwd: string = process.cwd()): Options {
  let homeDir = "";
  try {
    homeDir = userHomeDir(env);
  } catch {
    homeDir = "";
  }
  const goos = process.platform === "win32" ? "windows" : process.platform;
  return {
    homeDir,
    executablePath: process.execPath || "knowns",
    lookPath: (name) => lookPath(name, env),
    goos,
    cwd,
  };
}

export function runtimeNames(): string[] {
  return ["claude-code", "codex", "kiro", "opencode"];
}

const SPECS: RuntimeSpec[] = [
  {
    runtime: "claude-code",
    displayName: "Claude Code",
    hookKind: HOOK_KIND_NATIVE,
    binary: "claude",
    artifact: "CLAUDE.md, hooks, ...",
  },
  {
    runtime: "codex",
    displayName: "Codex",
    hookKind: HOOK_KIND_NATIVE,
    binary: "codex",
    artifact: ".codex/config.toml, hooks, ...",
  },
  {
    runtime: "kiro",
    displayName: "Kiro IDE",
    hookKind: HOOK_KIND_NATIVE,
    binary: "kiro",
    artifact: ".kiro/hooks/*.kiro.hook",
  },
  {
    runtime: "opencode",
    displayName: "OpenCode",
    hookKind: HOOK_KIND_PLUGIN,
    binary: "opencode",
    artifact: "plugin, config, ...",
  },
];

function lookupSpec(runtimeName: string): RuntimeSpec {
  const n = norm(runtimeName);
  const spec = SPECS.find((s) => s.runtime === n);
  if (!spec) throw new Error(`unsupported runtime "${runtimeName}"`);
  return spec;
}

function runtimeAvailable(spec: RuntimeSpec, opts: Options): boolean {
  if (!opts.lookPath) return false;
  return opts.lookPath(spec.binary) !== undefined;
}

function validateInstallable(spec: RuntimeSpec, opts: Options): void {
  if (opts.homeDir.trim() === "") {
    throw new Error(`cannot resolve home directory for ${spec.displayName} install`);
  }
  if (runtimeAvailable(spec, opts)) return;
  throw new Error(`${spec.displayName} CLI is not available in PATH`);
}

function shellExecutablePath(path: string, goos: string): string {
  // Claude for Windows runs command hooks through bash, so backslashes in a raw Windows path are
  // treated as escapes and collapse (C:\foo -> C:foo).
  return goos === "windows" ? path.replaceAll("\\", "/") : path;
}

function shellCommandString(args: string[], goos: string): string {
  return args.map((a, i) => (i === 0 ? shellExecutablePath(a, goos) : a)).join(" ");
}

function hookCommandArgsForEvent(spec: RuntimeSpec, opts: Options, event: string): string[] {
  let exe = opts.executablePath;
  if (opts.lookPath && opts.lookPath("knowns") !== undefined) exe = "knowns";
  return [exe, "runtime-memory", "hook", "--runtime", spec.runtime, "--event", event];
}

const hookCommandPath = (spec: RuntimeSpec, opts: Options) =>
  shellCommandString(
    hookCommandArgsForEvent(spec, opts, runtimeHookEvent(spec.runtime)),
    opts.goos,
  );

const baselineHookCommandPath = (spec: RuntimeSpec, opts: Options) =>
  shellCommandString(
    hookCommandArgsForEvent(spec, opts, baselineHookEvent(spec.runtime)),
    opts.goos,
  );

function legacyPromptCommandPath(spec: RuntimeSpec, opts: Options): string {
  return shellCommandString(
    [
      opts.executablePath,
      "runtime-memory",
      "hook",
      "--runtime",
      spec.runtime,
      "--event",
      DEFAULT_HOOK_EVENT,
    ],
    opts.goos,
  );
}

const kiroHookPath = (opts: Options) =>
  join(opts.cwd, ".kiro", "hooks", `${MANAGED_NAME}.kiro.hook`);

// --- hook group helpers -------------------------------------------------------------------------

type Groups = unknown[] | undefined;

const asGroups = (existing: unknown): unknown[] => (Array.isArray(existing) ? existing : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function commandHookGroupMatches(group: unknown, commandPath: string): boolean {
  if (!isMap(group)) return false;
  return asGroups(group.hooks).some((h) => isMap(h) && str(h.command).trim() === commandPath);
}

function hookGroupHasStatus(group: unknown, statusMessage: string): boolean {
  if (!isMap(group)) return false;
  return asGroups(group.hooks).some(
    (h) => isMap(h) && str(h.statusMessage).trim() === statusMessage,
  );
}

function hasCommandHookGroup(existing: unknown, commandPath: string): boolean {
  return asGroups(existing).some((g) => commandHookGroupMatches(g, commandPath));
}

function removeCommandHookGroup(existing: unknown, commandPath: string): Groups {
  const groups = asGroups(existing);
  if (groups.length === 0) return undefined;
  const filtered = groups.filter((g) => !commandHookGroupMatches(g, commandPath));
  return filtered.length === 0 ? undefined : filtered;
}

/** Removes every group whose statusMessage matches, whatever its command path. */
function removeManagedHookGroups(existing: unknown, statusMessage: string): Groups {
  const groups = asGroups(existing);
  if (groups.length === 0) return undefined;
  const filtered = groups.filter((g) => !hookGroupHasStatus(g, statusMessage));
  return filtered.length === 0 ? undefined : filtered;
}

function ensureCommandHookGroup(existing: unknown, commandPath: string, statusMessage: string) {
  const groups = asGroups(existing);
  const group = { hooks: [{ type: "command", command: commandPath, statusMessage }] };
  if (hasCommandHookGroup(existing, commandPath)) {
    return groups.map((g) => (commandHookGroupMatches(g, commandPath) ? group : g));
  }
  return [...groups, group];
}

function setOrDeleteHookGroups(hooks: JsonMap, key: string, groups: Groups): void {
  if (groups === undefined) delete hooks[key];
  else hooks[key] = groups;
}

function installNativeHooks(spec: RuntimeSpec, opts: Options, hooks: JsonMap): void {
  const promptKey = nativePromptHookKey(spec.runtime);
  const legacy = removeCommandHookGroup(hooks[promptKey], legacyPromptCommandPath(spec, opts));
  if (legacy === undefined) delete hooks[promptKey];
  else hooks[promptKey] = legacy;
  const managed = removeManagedHookGroups(hooks[promptKey], MANAGED_STATUS);
  hooks[promptKey] = ensureCommandHookGroup(managed, hookCommandPath(spec, opts), MANAGED_STATUS);
  const baselineKey = nativeBaselineHookKey(spec.runtime);
  if (baselineKey !== undefined) {
    const baseline = removeManagedHookGroups(hooks[baselineKey], MANAGED_STATUS);
    hooks[baselineKey] = ensureCommandHookGroup(
      baseline,
      baselineHookCommandPath(spec, opts),
      MANAGED_STATUS,
    );
  }
}

function uninstallNativeHooks(spec: RuntimeSpec, opts: Options, hooks: JsonMap): void {
  const promptKey = nativePromptHookKey(spec.runtime);
  let updated = removeCommandHookGroup(hooks[promptKey], hookCommandPath(spec, opts));
  updated = removeCommandHookGroup(updated, legacyPromptCommandPath(spec, opts));
  updated = removeManagedHookGroups(updated, MANAGED_STATUS);
  setOrDeleteHookGroups(hooks, promptKey, updated);
  let sessionStart = removeCommandHookGroup(
    hooks.SessionStart,
    baselineHookCommandPath(spec, opts),
  );
  sessionStart = removeManagedHookGroups(sessionStart, MANAGED_STATUS);
  setOrDeleteHookGroups(hooks, "SessionStart", sessionStart);
}

// --- Claude Code --------------------------------------------------------------------------------

function installClaude(spec: RuntimeSpec, opts: Options): void {
  const path = join(opts.homeDir, ".claude", CLAUDE_SETTINGS);
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  let config: JsonMap;
  try {
    config = readJsonMap(path);
  } catch (e) {
    throw new Error(`read Claude settings: ${(e as Error).message}`);
  }
  const hooks = isMap(config.hooks) ? config.hooks : {};
  installNativeHooks(spec, opts, hooks);
  config.hooks = hooks;
  writeJsonMap(path, config);
}

function uninstallClaude(spec: RuntimeSpec, opts: Options): void {
  const path = join(opts.homeDir, ".claude", CLAUDE_SETTINGS);
  const config = readJsonMap(path);
  if (!isMap(config.hooks)) return;
  const hooks = config.hooks;
  uninstallNativeHooks(spec, opts, hooks);
  if (Object.keys(hooks).length === 0) delete config.hooks;
  else config.hooks = hooks;
  writeJsonMap(path, config);
}

function addDetail(status: Status, detail: string): void {
  status.details = [...(status.details ?? []), detail];
}

function populateClaudeStatus(status: Status, spec: RuntimeSpec, opts: Options): void {
  const path = join(opts.homeDir, ".claude", CLAUDE_SETTINGS);
  status.paths = [path];
  let config: JsonMap;
  try {
    // readJSONMap treats a missing file as an empty object, so this only fails on a parse error.
    config = readJsonMap(path);
  } catch {
    status.state = STATE_MISSING;
    status.summary = "helper script installed, hook config missing";
    addDetail(status, "Claude settings missing");
    return;
  }
  const hooks = isMap(config.hooks) ? config.hooks : undefined;
  const promptKey = nativePromptHookKey(spec.runtime);
  if (!hooks || !hasCommandHookGroup(hooks[promptKey], hookCommandPath(spec, opts))) {
    status.state = STATE_DRIFTED;
    status.summary = "helper script present, Claude prompt hook missing";
    addDetail(status, `${promptKey} prompt-aware hook not installed`);
    return;
  }
  const baselineKey = nativeBaselineHookKey(spec.runtime);
  if (baselineKey !== undefined) {
    if (!hasCommandHookGroup(hooks[baselineKey], baselineHookCommandPath(spec, opts))) {
      status.state = STATE_DRIFTED;
      status.summary = "helper script present, Claude session hook missing";
      addDetail(status, `${baselineKey} session-baseline hook not installed`);
      return;
    }
  }
  status.installed = true;
  status.state = STATE_INSTALLED;
  status.summary = "installed";
  addDetail(status, `${promptKey} prompt-aware hook installed in ~/.claude/settings.json`);
}

// --- Codex --------------------------------------------------------------------------------------

function installCodex(spec: RuntimeSpec, opts: Options): void {
  const configPath = join(opts.homeDir, ".codex", CODEX_CONFIG);
  const hooksPath = join(opts.homeDir, ".codex", CODEX_HOOKS_FILE);
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o755 });
  let body = readTextIfExists(configPath);
  body = normalizeCodexHooksFeature(body);
  body = setCodexMcpServer(body, "knowns", ["mcp", "--stdio"]);
  writeFileSync(configPath, body, { mode: 0o644 });
  const hooks = readJsonMap(hooksPath);
  const hookRoot = isMap(hooks.hooks) ? hooks.hooks : {};
  installNativeHooks(spec, opts, hookRoot);
  hooks.hooks = hookRoot;
  writeJsonMap(hooksPath, hooks);
}

function uninstallCodex(spec: RuntimeSpec, opts: Options): void {
  const configPath = join(opts.homeDir, ".codex", CODEX_CONFIG);
  const hooksPath = join(opts.homeDir, ".codex", CODEX_HOOKS_FILE);
  try {
    const body = readTextIfExists(configPath);
    if (body !== "") writeFileSync(configPath, normalizeCodexHooksFeature(body), { mode: 0o644 });
  } catch {
    // Go ignores both the read and the write error here.
  }
  const hooks = readJsonMap(hooksPath);
  if (!isMap(hooks.hooks)) return;
  const hookRoot = hooks.hooks;
  uninstallNativeHooks(spec, opts, hookRoot);
  if (Object.keys(hookRoot).length === 0) delete hooks.hooks;
  else hooks.hooks = hookRoot;
  writeJsonMap(hooksPath, hooks);
}

function populateCodexStatus(status: Status, spec: RuntimeSpec, opts: Options): void {
  const configPath = join(opts.homeDir, ".codex", CODEX_CONFIG);
  const hooksPath = join(opts.homeDir, ".codex", CODEX_HOOKS_FILE);
  status.paths = [configPath, hooksPath];
  let body: string;
  try {
    body = readTextIfExists(configPath);
  } catch {
    status.state = STATE_DRIFTED;
    status.summary = "Codex config missing";
    addDetail(status, "~/.codex/config.toml not found");
    return;
  }
  if (body.includes("hooks = false") || body.includes("codex_hooks = false")) {
    status.state = STATE_DRIFTED;
    status.summary = "Codex hooks disabled in config";
    addDetail(status, "hooks feature disabled");
    return;
  }
  let hooks: JsonMap;
  try {
    hooks = readJsonMap(hooksPath);
  } catch {
    status.state = STATE_DRIFTED;
    status.summary = "Codex hooks file missing";
    addDetail(status, "~/.codex/hooks.json not found");
    return;
  }
  const hookRoot = isMap(hooks.hooks) ? hooks.hooks : undefined;
  const promptKey = nativePromptHookKey(spec.runtime);
  if (!hookRoot || !hasCommandHookGroup(hookRoot[promptKey], hookCommandPath(spec, opts))) {
    status.state = STATE_DRIFTED;
    status.summary = "Codex feature enabled, hook missing";
    addDetail(status, `${promptKey} prompt-aware hook not installed`);
    return;
  }
  const baselineKey = nativeBaselineHookKey(spec.runtime);
  if (baselineKey !== undefined) {
    if (!hasCommandHookGroup(hookRoot[baselineKey], baselineHookCommandPath(spec, opts))) {
      status.state = STATE_DRIFTED;
      status.summary = "Codex feature enabled, session hook missing";
      addDetail(status, `${baselineKey} session-baseline hook not installed`);
      return;
    }
  }
  status.installed = true;
  status.state = STATE_INSTALLED;
  status.summary = "installed";
  addDetail(status, `${promptKey} prompt-aware hook installed in ~/.codex/hooks.json`);
}

// --- Kiro ---------------------------------------------------------------------------------------

function installKiro(spec: RuntimeSpec, opts: Options): void {
  const hookPath = kiroHookPath(opts);
  mkdirSync(dirname(hookPath), { recursive: true, mode: 0o755 });
  // Prefer the bare "knowns" command when it is on PATH, so the hook stays portable.
  let cmdPath = "knowns";
  if (!opts.lookPath || opts.lookPath("knowns") === undefined) cmdPath = opts.executablePath;
  const hook: JsonMap = {
    version: "1.0.0",
    enabled: true,
    name: MANAGED_STATUS,
    description: "Inject bounded Knowns memory when a prompt is submitted.",
    when: { type: "promptSubmit" },
  };
  const thenKey = "then";
  hook[thenKey] = {
    type: "runCommand",
    command: `${cmdPath} runtime-memory hook --runtime ${spec.runtime} --event ${runtimeHookEvent(spec.runtime)}`,
  };
  writeJsonMap(hookPath, hook);
}

function uninstallKiro(_spec: RuntimeSpec, opts: Options): void {
  rmSync(kiroHookPath(opts), { force: true });
}

function populateKiroStatus(status: Status, spec: RuntimeSpec, opts: Options): void {
  const hookPath = kiroHookPath(opts);
  const mcpPath = join(opts.homeDir, ".kiro", "settings", KIRO_MCP_CONFIG);
  status.paths = [hookPath, mcpPath];
  let config: JsonMap;
  try {
    config = readJsonMap(hookPath);
  } catch {
    status.state = STATE_DRIFTED;
    status.summary = "Kiro IDE hook file missing";
    addDetail(status, `${baseName(hookPath)} not found in workspace .kiro/hooks`);
    return;
  }
  const when = isMap(config.when) ? config.when : {};
  const then = isMap(config.then) ? config.then : {};
  const cmd = str(then.command);
  const expectedSuffix = `runtime-memory hook --runtime ${spec.runtime} --event ${runtimeHookEvent(spec.runtime)}`;
  if (
    str(when.type) === "promptSubmit" &&
    str(then.type).toLowerCase() === "runcommand" &&
    cmd.endsWith(expectedSuffix)
  ) {
    status.installed = true;
    status.state = STATE_INSTALLED;
    status.summary = "installed";
    addDetail(
      status,
      "promptSubmit prompt-aware hook installed in workspace .kiro/hooks/knowns-runtime-memory.kiro.hook",
    );
    return;
  }
  status.state = STATE_DRIFTED;
  status.summary = "Kiro hook config missing";
  addDetail(status, "promptSubmit runCommand hook not installed");
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

// --- OpenCode -----------------------------------------------------------------------------------

function installOpenCode(_spec: RuntimeSpec, opts: Options): void {
  const configPath = join(opts.homeDir, ".config", "opencode", OPENCODE_CONFIG);
  const pluginPath = join(opts.homeDir, ".config", "opencode", "plugins", PLUGIN_FILE_NAME);
  mkdirSync(dirname(pluginPath), { recursive: true, mode: 0o755 });
  let config: JsonMap;
  try {
    config = readJsonMap(configPath);
  } catch (e) {
    throw new Error(`read OpenCode config: ${(e as Error).message}`);
  }
  config.$schema = "https://opencode.ai/config.json";
  const mcp = isMap(config.mcp) ? config.mcp : {};
  mcp.knowns = { type: "local", command: ["knowns", "mcp", "--stdio"], enabled: true };
  config.mcp = mcp;
  writeJsonMap(configPath, config);
  writeFileSync(pluginPath, renderOpenCodePlugin(opts), { mode: 0o644 });
}

function uninstallOpenCode(_spec: RuntimeSpec, opts: Options): void {
  rmSync(join(opts.homeDir, ".config", "opencode", "plugins", PLUGIN_FILE_NAME), { force: true });
}

function populateOpenCodeStatus(status: Status, _spec: RuntimeSpec, opts: Options): void {
  const configPath = join(opts.homeDir, ".config", "opencode", OPENCODE_CONFIG);
  const pluginPath = join(opts.homeDir, ".config", "opencode", "plugins", PLUGIN_FILE_NAME);
  status.paths = [configPath, pluginPath];
  if (!existsSync(pluginPath)) {
    addDetail(status, "global plugin file missing");
    return;
  }
  status.installed = true;
  status.state = STATE_INSTALLED;
  status.summary = "installed";
  if (existsSync(configPath)) {
    addDetail(status, "session-created baseline plugin installed in ~/.config/opencode/plugins");
  } else {
    addDetail(
      status,
      "session-created baseline plugin installed; global OpenCode config not present",
    );
  }
}

function escapeJsString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** renderOpenCodePlugin: the managed plugin source, byte for byte. */
export function renderOpenCodePlugin(opts: Pick<Options, "executablePath">): string {
  const exe = escapeJsString(opts.executablePath);
  return [
    "// managed-by: knowns",
    'import { execFileSync } from "node:child_process"',
    'import { appendFileSync, mkdirSync } from "node:fs"',
    'import { join } from "node:path"',
    "",
    "const injectedSessions = new Set()",
    'const debugEnabled = process.env.KNOWNS_RUNTIME_DEBUG === "1"',
    'const logPath = join(process.env.HOME || process.cwd(), ".knowns", "runtime", "opencode-runtime-memory.log")',
    "const log = (message, extra) => {",
    "  if (!debugEnabled) return",
    "  try {",
    '    mkdirSync(join(process.env.HOME || process.cwd(), ".knowns", "runtime"), { recursive: true })',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: plugin source text
    '    const suffix = extra ? ` ${JSON.stringify(extra)}` : ""',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: plugin source text
    "    appendFileSync(logPath, `[${new Date().toISOString()}] ${message}${suffix}\\n`)",
    "  } catch (_) {",
    "  }",
    "}",
    "",
    "// OpenCode 1.x publishes session.created on event.properties; OpenCode 2.x",
    "// publishes it on event.data with the session location beside it.",
    "const sessionInfo = (event) => {",
    "  const props = event?.properties || event?.data || {}",
    "  const sessionID = props.sessionID || props.sessionId || props.id || props.session?.id || props.info?.id",
    "  const location = props.location || event?.location || {}",
    "  const cwd = props.cwd || location.directory || process.cwd()",
    "  return { sessionID, cwd }",
    "}",
    "",
    "const knownsBaseline = (cwd) =>",
    '  execFileSync("' +
      exe +
      '", ["runtime-memory", "hook", "--runtime", "opencode", "--event", "session.created"], {',
    "    cwd,",
    "    env: { ...process.env },",
    "  }).toString().trim()",
    "",
    "// OpenCode 1.x entrypoint: its loader accepts a default-exported object with",
    "// server(input) and awaits the returned hooks object.",
    "const server = async ({ client }) => {",
    '  log("plugin initialized", { runtime: "opencode-v1" })',
    '  await client.app.log({ body: { service: "knowns-runtime-memory", level: "info", message: "OpenCode runtime memory plugin initialized" } })',
    "  return {",
    "    event: async ({ event }) => {",
    '      log("event received", { type: event?.type })',
    '      if (!event || event.type !== "session.created") return',
    "      try {",
    "        const { sessionID, cwd } = sessionInfo(event)",
    '        log("session.created parsed", { sessionID })',
    "        if (!sessionID || injectedSessions.has(sessionID)) return",
    "        const result = knownsBaseline(cwd)",
    '        log("knowns hook returned", { resultLength: result.length })',
    "        if (!result) return",
    "        injectedSessions.add(sessionID)",
    "        await client.session.prompt({",
    "          path: { id: sessionID },",
    "          body: {",
    "            noReply: true,",
    '            parts: [{ type: "text", text: result }],',
    "          },",
    "        })",
    '        log("session baseline injected", { sessionID })',
    "      } catch (error) {",
    '        log("injection failed", { error: String(error) })',
    '        await client.app.log({ body: { service: "knowns-runtime-memory", level: "warn", message: "OpenCode runtime memory injection failed", extra: { error: String(error) } } })',
    "      }",
    "    },",
    "  }",
    "}",
    "",
    "// OpenCode 2.x entrypoint: its loader requires a default definition with an",
    "// id and setup(ctx); events arrive through ctx.event.subscribe and baseline",
    "// text is injected with ctx.session.synthetic instead of client.session.prompt.",
    "const setup = async (ctx) => {",
    '  log("plugin initialized", { runtime: "opencode-v2" })',
    "  const controller = new AbortController()",
    "  const run = async () => {",
    "    try {",
    "      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {",
    '        log("event received", { type: event?.type })',
    '        if (!event || event.type !== "session.created") continue',
    "        try {",
    "          const { sessionID, cwd } = sessionInfo(event)",
    '          log("session.created parsed", { sessionID })',
    "          if (!sessionID || injectedSessions.has(sessionID)) continue",
    "          const result = knownsBaseline(cwd)",
    '          log("knowns hook returned", { resultLength: result.length })',
    "          if (!result) continue",
    "          injectedSessions.add(sessionID)",
    "          await ctx.session.synthetic({ sessionID, text: result, resume: false })",
    '          log("session baseline injected", { sessionID })',
    "        } catch (error) {",
    '          log("injection failed", { error: String(error) })',
    "        }",
    "      }",
    "    } catch (error) {",
    "      if (!controller.signal.aborted) {",
    '        log("event subscription failed", { error: String(error) })',
    "      }",
    "    }",
    "  }",
    "  void run()",
    "  return () => controller.abort()",
    "}",
    "",
    "export default {",
    '  id: "knowns.runtime-memory",',
    "  server,",
    "  setup,",
    "}",
    "",
  ].join("\n");
}

// --- public API -----------------------------------------------------------------------------------

export function install(runtimeName: string, opts: Options): void {
  const spec = lookupSpec(runtimeName);
  validateInstallable(spec, opts);
  switch (spec.runtime) {
    case "claude-code":
      installClaude(spec, opts);
      return;
    case "codex":
      installCodex(spec, opts);
      return;
    case "kiro":
      installKiro(spec, opts);
      return;
    case "opencode":
      installOpenCode(spec, opts);
      return;
    default:
      throw new Error(`unsupported runtime "${runtimeName}"`);
  }
}

export function uninstall(runtimeName: string, opts: Options): void {
  const spec = lookupSpec(runtimeName);
  switch (spec.runtime) {
    case "claude-code":
      uninstallClaude(spec, opts);
      return;
    case "codex":
      uninstallCodex(spec, opts);
      return;
    case "kiro":
      uninstallKiro(spec, opts);
      return;
    case "opencode":
      uninstallOpenCode(spec, opts);
      return;
    default:
      throw new Error(`unsupported runtime "${runtimeName}"`);
  }
}

export function statusFor(runtimeName: string, opts: Options): Status {
  const spec = lookupSpec(runtimeName);
  const status: Status = {
    runtime: spec.runtime,
    displayName: spec.displayName,
    hookKind: spec.hookKind,
    available: runtimeAvailable(spec, opts),
    installed: false,
    state: STATE_MISSING,
    summary: "not installed",
  };
  switch (spec.runtime) {
    case "claude-code":
      populateClaudeStatus(status, spec, opts);
      break;
    case "codex":
      populateCodexStatus(status, spec, opts);
      break;
    case "kiro":
      populateKiroStatus(status, spec, opts);
      break;
    case "opencode":
      populateOpenCodeStatus(status, spec, opts);
      break;
  }
  return status;
}

export function statusAll(opts: Options): Status[] {
  return runtimeNames().map((n) => statusFor(n, opts));
}

export function runtimePickerLabel(runtimeName: string, opts: Options): string {
  let spec: RuntimeSpec;
  try {
    spec = lookupSpec(runtimeName);
  } catch {
    return runtimeName;
  }
  const parts = [spec.displayName, `(${spec.artifact}`];
  if (runtimeAvailable(spec, opts)) parts.push("Available");
  return `${parts.join(", ")})`;
}

export function runtimePickerDescription(runtimeName: string, opts: Options): string {
  let spec: RuntimeSpec;
  try {
    spec = lookupSpec(runtimeName);
  } catch {
    return "";
  }
  switch (spec.runtime) {
    case "claude-code":
      return "Installs global native memory hooks for Claude Code";
    case "codex":
      return "Installs global native memory hooks for Codex";
    case "kiro":
      return "Installs global native memory hooks for Kiro";
    case "opencode":
      return runtimeAvailable(spec, opts)
        ? "Installs global OpenCode memory plugin"
        : "Installs OpenCode, then adds the global Knowns memory plugin";
    default:
      return "";
  }
}

export function runtimeAvailabilitySummary(runtimeName: string, opts: Options): string {
  let status: Status;
  try {
    status = statusFor(runtimeName, opts);
  } catch {
    return "unavailable";
  }
  if (status.installed) return "installed";
  if (status.available) return "available";
  return "unavailable";
}

// --- Codex TOML helpers -----------------------------------------------------------------------

/** fmt.Sprintf("%q", s): a Go double-quoted string literal. */
export function goQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c === 7) out += "\\a";
    else if (c === 8) out += "\\b";
    else if (c === 12) out += "\\f";
    else if (c === 11) out += "\\v";
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

/** normalizeCodexHooksFeature: fold the deprecated codex_hooks key into hooks inside [features]. */
export function normalizeCodexHooksFeature(body: string): string {
  const lines = body.split("\n");
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] as string).trim() === "[features]") {
      start = i;
      end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        const t = (lines[j] as string).trim();
        if (t.startsWith("[") && t.endsWith("]")) {
          end = j;
          break;
        }
      }
      break;
    }
  }
  if (start === -1) return body;

  let hasHooks = false;
  let hasCodexHooks = false;
  let codexHooksDisabled = false;
  const featureLines: string[] = [];
  for (let i = start + 1; i < end; i++) {
    const line = lines[i] as string;
    const trimmed = line.trim();
    if (trimmed.startsWith("hooks =")) hasHooks = true;
    if (trimmed.startsWith("codex_hooks =")) {
      hasCodexHooks = true;
      codexHooksDisabled = trimmed.slice("codex_hooks =".length).trim().toLowerCase() === "false";
      continue;
    }
    featureLines.push(line);
  }
  if (!hasCodexHooks) return body;
  if (codexHooksDisabled && !hasHooks) featureLines.push("hooks = false");
  return [...lines.slice(0, start + 1), ...featureLines, ...lines.slice(end)].join("\n");
}

/** SetCodexMCPServer: upsert the [mcp_servers.knowns] section of a Codex config.toml. */
export function setCodexMcpServer(body: string, command: string, args: string[]): string {
  body = normalizeCodexHooksFeature(body);
  const lines = body.split("\n");
  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] as string).trim() === "[mcp_servers.knowns]") {
      sectionStart = i;
      for (let j = i + 1; j < lines.length; j++) {
        const t = (lines[j] as string).trim();
        if (t.startsWith("[") && t.endsWith("]")) {
          sectionEnd = j;
          break;
        }
      }
      break;
    }
  }
  const newSection = [
    "[mcp_servers.knowns]",
    `command = ${goQuote(command)}`,
    `args = [${args.map(goQuote).join(", ")}]`,
  ];
  if (sectionStart === -1) {
    body = body.replace(/\n+$/, "");
    if (body !== "") body += "\n\n";
    return `${body}${newSection.join("\n")}\n`;
  }
  return [...lines.slice(0, sectionStart), ...newSection, ...lines.slice(sectionEnd)].join("\n");
}

/** SortStatuses: by runtime name. */
export function sortStatuses(statuses: Status[]): void {
  statuses.sort((a, b) => (a.runtime < b.runtime ? -1 : a.runtime > b.runtime ? 1 : 0));
}
