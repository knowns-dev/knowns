// `knowns config` get, set, list and reset (internal/cli/config.go). The interactive `settings`
// command (huh forms) is not part of this file and stays an unported placeholder.
import { defaultProjectSettings, type Project } from "../../models/config.ts";
import { exactArgs } from "../core/args.ts";
import { defineCommand } from "../core/define.ts";
import { goQuote, parseGoBool, parseGoFloat, parseGoInt } from "../core/gofmt.ts";
import { renderSectionHeader, renderSuccess, StyleBold, StyleDim } from "../core/plainoutput.ts";
import { scanToken } from "./memory-support.ts";

/** The Go side's `normalizedSemanticProvider` (spec ollama-only-embedding D1). */
export function normalizedSemanticProvider(provider: string): string {
  return provider === "" || provider === "local" ? "ollama" : provider;
}

function isRawJson(v: object): boolean {
  return Object.hasOwn(v, "rawJSON") && Object.getPrototypeOf(v) === null;
}

/** Go's json.Marshal text of a decoded generic value (map keys sorted, html-escaped, compact). */
async function compactJSON(v: unknown): Promise<string> {
  const { goJsonStringify, sortKeysDeep } = await import("../../storage/core/util.ts");
  return goJsonStringify(sortKeysDeep(v), 0);
}

/** formatConfigValue: a config value as one line of text. */
export async function formatConfigValue(v: unknown): Promise<string> {
  if (v === null || v === undefined) return "";
  switch (typeof v) {
    case "string":
      return v;
    case "boolean":
      return v ? "true" : "false";
    case "number":
      return String(v);
    default:
      break;
  }
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const item of v) parts.push(await formatConfigValue(item));
    return parts.join(", ");
  }
  if (typeof v === "object" && isRawJson(v)) return (v as { rawJSON: string }).rawJSON;
  return compactJSON(v);
}

/** The value `config set` stores for the raw argument: int, then float, then bool, else string. */
export function parseConfigValue(raw: string): unknown {
  const i = parseGoInt(raw, 10);
  if (i.ok) {
    const n = Number(i.value);
    return Number.isSafeInteger(n) ? n : JSON.rawJSON(i.value.toString());
  }
  const f = parseGoFloat(raw);
  if (f.ok) return f.value;
  const b = parseGoBool(raw);
  if (b.ok) return b.value;
  return raw;
}

/** Shorthand keys `config set` resolves. */
export function resolveConfigSetKey(key: string): string {
  if (key === "lsp") return "settings.lsp.enabled";
  if (key.startsWith("lsp.") && !key.slice(4).includes(".")) {
    return `settings.lsp.languages.${key.slice(4)}.enabled`;
  }
  if (key === "embedding" || key === "semanticSearch") return "settings.semanticSearch.enabled";
  if (!key.includes(".") && key !== "name" && key !== "id") return `settings.${key}`;
  return key;
}

/** Go field types of the directly typed project and settings keys (models.Project / ProjectSettings). */
type GoType = "string" | "int" | "bool" | "[]string" | "map[string]string";
const PS = "ProjectSettings";
const GO_FIELD_TYPES: Record<string, { struct: string; type: GoType }> = {
  name: { struct: "Project", type: "string" },
  id: { struct: "Project", type: "string" },
  "settings.defaultAssignee": { struct: PS, type: "string" },
  "settings.defaultPriority": { struct: PS, type: "string" },
  "settings.defaultTaskIdPrefix": { struct: PS, type: "string" },
  "settings.timeFormat": { struct: PS, type: "string" },
  "settings.editor": { struct: PS, type: "string" },
  "settings.gitTrackingMode": { struct: PS, type: "string" },
  "settings.skillsScope": { struct: PS, type: "string" },
  "settings.serverPort": { struct: PS, type: "int" },
  "settings.defaultLabels": { struct: PS, type: "[]string" },
  "settings.codeIntelligenceIgnore": { struct: PS, type: "[]string" },
  "settings.statuses": { struct: PS, type: "[]string" },
  "settings.visibleColumns": { struct: PS, type: "[]string" },
  "settings.platforms": { struct: PS, type: "[]string" },
  "settings.statusColors": { struct: PS, type: "map[string]string" },
  "settings.semanticSearch.enabled": { struct: "SemanticSearchSettings", type: "bool" },
  "settings.lsp.enabled": { struct: "LSPSettings", type: "bool" },
};

const INT64_LIMIT = 2 ** 63;

/**
 * What encoding/json says when the value cannot be stored in the typed field (Go validates by
 * unmarshalling the edited config into models.Project). Covers the keys in GO_FIELD_TYPES; any
 * other key keeps the library's own validation message. `config set` only ever writes scalars.
 */
export function goUnmarshalMismatch(key: string, val: unknown, _raw: string): string {
  const field = GO_FIELD_TYPES[key];
  if (!field) return "";
  const isBig = typeof val === "object" && val !== null; // a JSON.rawJSON integer
  const kind =
    typeof val === "string"
      ? "string"
      : typeof val === "boolean"
        ? "bool"
        : typeof val === "number" || isBig
          ? "number"
          : "";
  if (kind === "") return "";
  const literal = isBig ? (val as { rawJSON: string }).rawJSON : JSON.stringify(val);
  const fits =
    field.type === "int" &&
    kind === "number" &&
    (isBig || (Number.isInteger(val as number) && Math.abs(val as number) < INT64_LIMIT));
  if (field.type === "string" && kind === "string") return "";
  if (field.type === "bool" && kind === "bool") return "";
  if (fits) return "";
  const received = kind === "number" && field.type === "int" ? `number ${literal}` : kind;
  return `json: cannot unmarshal ${received} into Go struct field ${field.struct}.${key} of type ${field.type}`;
}

const padRunes = (s: string, n: number): string => {
  const count = [...s].length;
  return count >= n ? s : s + " ".repeat(n - count);
};

const sortedKeys = <T>(m: Record<string, T>): string[] =>
  Object.keys(m).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

function plainList(project: Project): string {
  const s = project.settings;
  let out = `PROJECT: ${project.name}\n`;
  out += `ID: ${project.id}\n`;
  out += `settings.defaultAssignee: ${s.defaultAssignee ?? ""}\n`;
  out += `settings.defaultPriority: ${s.defaultPriority}\n`;
  out += `settings.defaultTaskIdPrefix: ${s.defaultTaskIdPrefix ?? ""}\n`;
  out += `settings.statuses: ${(s.statuses ?? []).join(", ")}\n`;
  if ((s.serverPort ?? 0) !== 0) out += `settings.serverPort: ${s.serverPort}\n`;
  if ((s.gitTrackingMode ?? "") !== "") out += `settings.gitTrackingMode: ${s.gitTrackingMode}\n`;
  const ss = s.semanticSearch;
  if (ss) {
    out += `settings.semanticSearch.enabled: ${ss.enabled === true}\n`;
    if ((ss.model ?? "") !== "") out += `settings.semanticSearch.model: ${ss.model}\n`;
    if ((ss.provider ?? "") !== "") out += `settings.semanticSearch.provider: ${ss.provider}\n`;
  }
  const lsp = s.lsp;
  if (lsp) {
    if (lsp.enabled !== undefined && lsp.enabled !== null) {
      out += `settings.lsp.enabled: ${lsp.enabled}\n`;
    }
    // Go ranges over a map (random order); sorted here so the output is stable.
    for (const lang of sortedKeys(lsp.languages ?? {})) {
      const ls = lsp.languages?.[lang];
      if (!ls) continue;
      if (ls.enabled !== undefined && ls.enabled !== null) {
        out += `settings.lsp.languages.${lang}.enabled: ${ls.enabled}\n`;
      }
      if ((ls.binary ?? "") !== "") out += `settings.lsp.languages.${lang}.binary: ${ls.binary}\n`;
      if ((ls.backend ?? "") !== "") {
        out += `settings.lsp.languages.${lang}.backend: ${ls.backend}\n`;
      }
      if ((ls.projectPath ?? "") !== "") {
        out += `settings.lsp.languages.${lang}.projectPath: ${ls.projectPath}\n`;
      }
    }
  }
  return out;
}

function styledList(project: Project): string {
  const s = project.settings;
  const dim = (t: string) => StyleDim.render(t);
  let out = `${StyleBold.render(project.name)} ${dim(`(ID: ${project.id})`)}\n\n`;
  out += `${renderSectionHeader("Settings")}\n`;
  out += `  ${dim("defaultAssignee:")} ${s.defaultAssignee ?? ""}\n`;
  out += `  ${dim("defaultPriority:")} ${s.defaultPriority}\n`;
  out += `  ${dim("taskIdPrefix:   ")} ${s.defaultTaskIdPrefix ?? ""}\n`;
  out += `  ${dim("statuses:       ")} ${(s.statuses ?? []).join(", ")}\n`;
  if ((s.serverPort ?? 0) !== 0) out += `  ${dim("serverPort:     ")} ${s.serverPort}\n`;
  if ((s.gitTrackingMode ?? "") !== "")
    out += `  ${dim("gitTrackingMode:")} ${s.gitTrackingMode}\n`;
  if ((s.timeFormat ?? "") !== "") out += `  ${dim("timeFormat:     ")} ${s.timeFormat}\n`;
  const ss = s.semanticSearch;
  if (ss) {
    out += `${renderSectionHeader("Semantic Search")}\n`;
    out += `  ${dim("enabled:      ")} ${ss.enabled === true}\n`;
    if ((ss.model ?? "") !== "") out += `  ${dim("model:        ")} ${ss.model}\n`;
    if ((ss.provider ?? "") !== "") out += `  ${dim("provider:     ")} ${ss.provider}\n`;
  }
  const lsp = s.lsp;
  if (lsp) {
    out += `${renderSectionHeader("LSP (Experimental)")}\n`;
    if (lsp.enabled !== undefined && lsp.enabled !== null) {
      out += `  ${dim("enabled:      ")} ${lsp.enabled}\n`;
    }
    for (const lang of sortedKeys(lsp.languages ?? {})) {
      const ls = lsp.languages?.[lang];
      if (!ls) continue;
      const col = (name: string) => dim(padRunes(`${lang}.${name}:`, 14));
      if (ls.enabled !== undefined && ls.enabled !== null) {
        out += `  ${col("enabled")} ${ls.enabled}\n`;
      }
      if ((ls.binary ?? "") !== "") out += `  ${col("binary")} ${ls.binary}\n`;
      if ((ls.backend ?? "") !== "") out += `  ${col("backend")} ${ls.backend}\n`;
      if ((ls.projectPath ?? "") !== "") out += `  ${col("project")} ${ls.projectPath}\n`;
    }
  }
  return out;
}

/**
 * The ConfigStore for a located project. Only a project whose knowledge lives in a store clone keeps
 * personal and machine settings outside config.json (Go: `if inStoresDir(root) { split = ... }`);
 * an in-repo .knowns/ never does.
 */
export async function openConfig(store: { root: string; projectRoot: string }) {
  const { ConfigStore } = await import("../../storage/stores/config-store.ts");
  const { inStoresDir } = await import("../../storage/core/index.ts");
  return new ConfigStore(store.root, inStoresDir(store.root) ? store.projectRoot : undefined);
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const getCmd = defineCommand({
  use: "get <key>",
  short: "Get a config value",
  args: exactArgs(1),
  async run(ctx) {
    const key = ctx.args[0] as string;
    const config = await openConfig(await ctx.getStore());

    let val: unknown;
    try {
      val = config.get(key);
    } catch (e) {
      let err: unknown = e;
      if (!key.startsWith("settings.")) {
        try {
          val = config.get(`settings.${key}`);
          err = undefined;
        } catch (e2) {
          err = e2;
        }
      }
      if (err !== undefined) throw new Error(`config get ${goQuote(key)}: ${errMessage(err)}`);
    }

    if (ctx.json) {
      const { sortKeysDeep } = await import("../../storage/core/util.ts");
      ctx.printJSON(sortKeysDeep(val ?? null));
      return;
    }
    if (ctx.plain) {
      ctx.print(`${await formatConfigValue(val)}\n`);
      return;
    }
    ctx.print(`${StyleBold.render(key)} ${StyleDim.render("=")} ${await formatConfigValue(val)}\n`);
  },
});

const setCmd = defineCommand({
  use: "set <key> <value>",
  short: "Set a config value",
  args: exactArgs(2),
  async run(ctx) {
    const key = ctx.args[0] as string;
    const rawVal = ctx.args[1] as string;
    const config = await openConfig(await ctx.getStore());

    const val = parseConfigValue(rawVal);
    const actualKey = resolveConfigSetKey(key);
    if (typeof val === "number" && !Number.isFinite(val)) {
      throw new Error(
        `config set ${goQuote(key)}: marshal config for validation: json: unsupported value: ${Number.isNaN(val) ? "NaN" : val > 0 ? "+Inf" : "-Inf"}`,
      );
    }
    const mismatch = goUnmarshalMismatch(actualKey, val, rawVal);
    if (mismatch !== "") {
      throw new Error(`config set ${goQuote(key)}: parse config for validation: ${mismatch}`);
    }
    try {
      config.set(actualKey, val);
    } catch (e) {
      throw new Error(`config set ${goQuote(key)}: ${errMessage(e)}`);
    }

    // Regenerate .gitignore when gitTracking toggles change.
    if (actualKey.startsWith("settings.gitTracking.")) {
      try {
        const project = config.load();
        const mode = (project.settings.gitTrackingMode ?? "") || "git-tracked";
        const { writeKnownsGitignore } = await import("./config-gitignore.ts");
        writeKnownsGitignore(ctx.cwd, mode, project.settings.gitTracking);
      } catch (e) {
        ctx.printErr(`Warning: failed to regenerate .gitignore: ${errMessage(e)}\n`);
      }
    }

    ctx.print(`${renderSuccess(`Set ${key} = ${rawVal}`)}\n`);
  },
});

const listCmd = defineCommand({
  use: "list",
  short: "List all config settings",
  async run(ctx) {
    const { projectToGo } = await import("../../storage/stores/config-store.ts");
    const config = await openConfig(await ctx.getStore());
    let project: Project;
    try {
      project = config.load();
    } catch (e) {
      throw new Error(`load config: ${errMessage(e)}`);
    }
    if (ctx.json) {
      ctx.printJSON(projectToGo(project as unknown as Record<string, never>));
      return;
    }
    ctx.print(ctx.plain ? plainList(project) : styledList(project));
  },
});

const resetCmd = defineCommand({
  use: "reset",
  short: "Reset config to defaults",
  flags: [
    {
      type: "bool",
      name: "yes",
      shorthand: "y",
      usage: "Skip confirmation prompt",
      default: false,
    },
  ],
  async run(ctx) {
    const config = await openConfig(await ctx.getStore());

    if (!ctx.flags.bool("yes")) {
      ctx.print("Reset config to defaults? This cannot be undone. (y/n): ");
      const answer = scanToken();
      if (answer !== "y" && answer !== "yes") {
        ctx.print("Aborted.\n");
        return;
      }
    }

    let name = "knowns";
    let id = "";
    let current: Project | undefined;
    try {
      current = config.load();
    } catch {
      current = undefined;
    }
    if (current && current.name !== "") name = current.name;
    if (current) id = current.id;

    try {
      config.set("settings", null);
    } catch {
      // Go ignores this failure and rewrites the whole config below.
    }

    // Go saves a models.Project whose CreatedAt is the zero time.
    const project = {
      name,
      id,
      createdAt: "0001-01-01T00:00:00Z",
      settings: defaultProjectSettings(),
    } as unknown as Project;
    try {
      config.save(project);
    } catch (e) {
      throw new Error(`reset config: ${errMessage(e)}`);
    }
    ctx.print(`${renderSuccess("Config reset to defaults.")}\n`);
  },
});

export default defineCommand({
  use: "config",
  short: "Manage project configuration",
  subcommands: [getCmd, setCmd, listCmd, resetCmd],
});
