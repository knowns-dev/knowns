// `knowns runtime memory hook` and its compatibility path `knowns runtime-memory hook`
// (internal/cli/runtime_memory.go). Two identical hook commands, because the old path is baked
// into every hook script, OpenCode plugin and Kiro hook file `knowns setup` already wrote. The
// legacy root is deprecated but silent (internal/cli/lifecycle.go): its output is the memory
// payload itself and must stay clean.
import { join } from "node:path";
import {
  build,
  captureWithOutcome,
  type HybridCandidate,
  hybridCandidatesFrom,
  type Input,
  normalizeCaptureMode,
  normalizeMode,
  normalizeSettings,
  packJSON,
} from "../../domain/runtimememory/index.ts";
import { type CommandContext, type CommandSpec, defineCommand } from "../core/define.ts";

/** Seams for tests: the hook reads stdin only when no prompt came through the environment. */
export const hookIO = {
  readStdin: async (): Promise<string> => {
    try {
      return await Bun.stdin.text();
    } catch {
      return "";
    }
  },
};

function trimSpace(s: string): string {
  return s.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, "");
}

async function runtimeMemoryPrompt(env: Record<string, string | undefined>): Promise<string> {
  const fromEnv = trimSpace(env.KNOWNS_RUNTIME_PROMPT ?? "");
  if (fromEnv !== "") return fromEnv;
  const user = trimSpace(env.USER_PROMPT ?? "");
  if (user !== "") return user;
  const body = await hookIO.readStdin();
  const trimmed = trimSpace(body);
  if (trimmed === "") return "";
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    // Not JSON: some runtimes pipe the bare prompt text.
    return trimmed;
  }
  // Go unmarshals into map[string]any: only a JSON object counts as a structured payload.
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return trimmed;
  const map = payload as Record<string, unknown>;
  for (const key of ["prompt", "text", "message"]) {
    const v = map[key];
    if (typeof v === "string" && trimSpace(v) !== "") return trimSpace(v);
  }
  return "";
}

async function semanticLookup(
  storage: import("../../storage/adapters.ts").Storage,
  input: Input,
  limit: number,
  ctx: CommandContext,
): Promise<HybridCandidate[] | undefined> {
  if (trimSpace(input.userPrompt) === "") return undefined;
  const { initSemanticSqlite, autoReindexIfStale } = await import(
    "../../runtime/index/init-semantic.ts"
  );
  const { buildSearchEnvironment } = await import("../../domain/searchenv/index.ts");
  const { mockEmbedderEnabled } = await import("../../search/mock-embedder.ts");
  const { Engine } = await import("../../search/engine.ts");
  const { openMemorySemanticStores } = await import("../../search/runtime.ts");
  const env = buildSearchEnvironment({ env: ctx.env });
  let sem: Awaited<ReturnType<typeof initSemanticSqlite>>;
  try {
    sem = initSemanticSqlite(storage, env);
  } catch {
    return undefined;
  }
  try {
    if (!mockEmbedderEnabled(ctx.env)) await autoReindexIfStale(storage, sem);
    const engine = new Engine({
      storage,
      embedder: sem.embedder,
      // Go's engine reads the legacy SQLite index only for SemanticAvailable(); memory hits come
      // from the per-layer runtime sessions (memorySemantic).
      vecStore: sem.store,
      memorySemantic: () => openMemorySemanticStores(storage, env),
      ...(env.references && { references: env.references }),
      ...(env.now && { now: env.now }),
    });
    if (!engine.semanticAvailable()) return undefined;
    return await hybridCandidatesFrom(
      storage,
      async (opts) => {
        const out = await engine.searchWithDegradation(opts);
        return { results: out.results, degraded: out.degraded };
      },
      input,
      limit,
    );
  } finally {
    sem.embedder.close();
    await sem.store.close();
  }
}

async function runHook(ctx: CommandContext): Promise<void> {
  const runtimeName = ctx.flags.string("runtime");
  const eventName = ctx.flags.string("event");
  let projectRoot = ctx.flags.string("project");
  const mode = ctx.flags.string("mode");
  const capture = ctx.flags.string("capture");
  let workingDir = ctx.flags.string("cwd");
  const maxItems = ctx.flags.int("max-items");
  const maxBytes = ctx.flags.int("max-bytes");

  if (trimSpace(runtimeName) === "") throw new Error("--runtime is required");
  if (trimSpace(eventName) === "") throw new Error("--event is required");
  if (workingDir === "") workingDir = ctx.cwd;

  const { Store, locateProject, locateProjectAt } = await import("../../storage/core/index.ts");
  const { createStorage } = await import("../../storage/adapters.ts");
  let store: InstanceType<typeof Store>;
  if (projectRoot !== "") {
    try {
      const loc = locateProjectAt(projectRoot);
      store = new Store(loc.knowledgeRoot, loc.projectRoot);
      projectRoot = loc.projectRoot;
    } catch {
      // An explicit --project that is not a project keeps working with default settings.
      store = Store.open(join(projectRoot, ".knowns"));
    }
  } else if (workingDir !== "") {
    let loc: ReturnType<typeof locateProject>;
    try {
      loc = locateProject(workingDir);
    } catch {
      return;
    }
    store = new Store(loc.knowledgeRoot, loc.projectRoot);
    projectRoot = loc.projectRoot;
  } else {
    return;
  }
  const storage = createStorage(store);

  let settings = normalizeSettings(undefined);
  try {
    settings = normalizeSettings(storage.config.load().settings.runtimeMemory);
  } catch {
    // Go keeps the defaults when the config cannot be loaded.
  }
  // Go: NormalizeMode never returns "", so the flag always wins, absent or not (config mode is
  // overridden to auto). Kept for parity.
  settings.mode = normalizeMode(mode);
  if (trimSpace(capture) !== "") settings.capture = normalizeCaptureMode(capture);
  if (maxItems > 0) settings.maxItems = maxItems;
  if (maxBytes > 0) settings.maxBytes = maxBytes;

  const prompt = await runtimeMemoryPrompt(ctx.env);
  const input: Input = {
    runtime: runtimeName,
    projectRoot,
    workingDir,
    actionType: eventName,
    userPrompt: prompt,
    mode: settings.mode,
    capture: settings.capture,
    maxItems: settings.maxItems,
    maxBytes: settings.maxBytes,
  };
  const pack = await build(storage, input, (s, i, limit) => semanticLookup(s, i, limit, ctx));
  pack.capture = await captureWithOutcome(storage, input);
  if (ctx.json) {
    ctx.printJSON(packJSON(pack));
    return;
  }
  if (trimSpace(pack.serialized ?? "") === "") return;
  ctx.print(`${pack.serialized}\n`);
}

/** A fresh hook command; each parent needs its own instance. */
export function hookCommand(): CommandSpec {
  return defineCommand({
    use: "hook",
    short: "Build a runtime memory payload for adapter hooks",
    flags: [
      { type: "string", name: "runtime", usage: "Runtime adapter name" },
      { type: "string", name: "event", usage: "Hook event name" },
      { type: "string", name: "project", usage: "Project root (defaults to detected project)" },
      { type: "string", name: "cwd", usage: "Working directory for scoring context" },
      { type: "string", name: "mode", usage: "Override runtime memory mode" },
      { type: "string", name: "capture", usage: "Override runtime memory capture mode" },
      { type: "int", name: "max-items", usage: "Override maximum number of memory items" },
      { type: "int", name: "max-bytes", usage: "Override maximum serialized bytes" },
    ],
    run: runHook,
  });
}

/** `knowns runtime memory`. */
export function runtimeMemoryGroup(): CommandSpec {
  return defineCommand({
    use: "memory",
    short: "Manage runtime memory hook behavior",
    subcommands: [hookCommand()],
  });
}

/** `knowns runtime-memory`: the deprecated, hidden, silent compatibility root. */
export default defineCommand({
  use: "runtime-memory",
  short: 'Manage runtime memory hook behavior (use "knowns runtime memory")',
  hidden: true,
  subcommands: [hookCommand()],
});
