// `knowns provider`: register, list, remove and test OpenAI-compatible embedding API providers in
// ~/.knowns/settings.json (internal/cli/provider.go).
import { goTransportError } from "../../platform/goerror.ts";
import { exactArgs } from "../core/args.ts";
import { type CommandContext, defineCommand } from "../core/define.ts";

async function settingsStore() {
  const m = await import("../../storage/stores/embedding-settings-store.ts");
  return m;
}

function loadSettings(m: Awaited<ReturnType<typeof settingsStore>>) {
  const store = new m.EmbeddingSettingsStore();
  try {
    return { store, settings: store.load() };
  } catch (e) {
    throw new Error(`load settings: ${(e as Error).message}`);
  }
}

/** Go's %q of a string. */
function q(s: string): string {
  return JSON.stringify(s);
}

/** testProviderConnectivity: any response below 500 means the server is reachable. */
async function testProviderConnectivity(apiBase: string, apiKey: string): Promise<void> {
  const url = `${apiBase}/embeddings`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`create request: parse ${q(url)}: invalid URI for request`);
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey !== "") headers.Authorization = `Bearer ${apiKey}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  let resp: Response;
  try {
    resp = await fetch(parsed, {
      method: "POST",
      headers,
      body: '{"model":"test","input":["hello"]}',
      signal: ctrl.signal,
    });
  } catch (e) {
    const err =
      ctrl.signal.aborted && !(e as { code?: string }).code
        ? Object.assign(new Error("timeout"), { name: "TimeoutError" })
        : e;
    throw new Error(`connection failed: ${goTransportError("POST", url, err)}`);
  } finally {
    clearTimeout(timer);
  }
  await resp.arrayBuffer().catch(() => undefined);
  if (resp.status >= 500) throw new Error(`server error (HTTP ${resp.status})`);
}

async function runAdd(ctx: CommandContext): Promise<void> {
  const m = await settingsStore();
  const { store, settings } = loadSettings(m);
  let id = ctx.flags.string("id");
  let name = ctx.flags.string("name");
  let apiBase = ctx.flags.string("api-base");
  const apiKey = ctx.flags.string("api-key");
  const { OllamaDetector, OLLAMA_DEFAULT_BASE } = await import("../../search/ollama.ts");

  if (id === "" && apiBase === "") {
    const detected = await new OllamaDetector(OLLAMA_DEFAULT_BASE).isRunning();
    if (!detected.running) {
      throw new Error(`no --api-base provided and Ollama not detected at ${OLLAMA_DEFAULT_BASE}`);
    }
    ctx.print(`✓ Detected Ollama ${detected.version} at ${OLLAMA_DEFAULT_BASE}\n`);
    id = "ollama";
    name = "Ollama Local";
    apiBase = `${OLLAMA_DEFAULT_BASE}/v1`;
  }
  if (id === "") throw new Error("--id is required");
  if (apiBase === "") throw new Error("--api-base is required");
  if (name === "") name = id;

  ctx.print(`Testing connectivity to ${apiBase}...\n`);
  try {
    await testProviderConnectivity(apiBase, apiKey);
  } catch (e) {
    throw new Error(`connectivity test failed: ${(e as Error).message}\nProvider not saved.`);
  }
  ctx.print("✓ Connection successful\n");

  const provider = m.providerWithDefaults({ name, apiBase, apiKey });
  m.addProvider(settings, id, provider);
  try {
    store.save(settings);
  } catch (e) {
    throw new Error(`save settings: ${(e as Error).message}`);
  }
  ctx.print(`✓ Provider ${q(id)} registered\n`);
  ctx.print(`  API Base: ${apiBase}\n`);

  if (apiBase.includes("11434") || name.toLowerCase().includes("ollama")) {
    const ollamaBase = apiBase.endsWith("/v1") ? apiBase.slice(0, -3) : apiBase;
    let models: Awaited<ReturnType<InstanceType<typeof OllamaDetector>["listEmbeddingModels"]>> =
      [];
    try {
      models = await new OllamaDetector(ollamaBase).listEmbeddingModels();
    } catch {
      models = [];
    }
    if (models.length > 0) {
      ctx.print("\n  Available embedding models:\n");
      for (const model of models) ctx.print(`    • ${model.shortName} (${model.dimensions}d)\n`);
      ctx.print("\n  Select one: knowns config set settings.semanticSearch.model <name>\n");
    }
  }
}

async function runList(ctx: CommandContext): Promise<void> {
  const m = await settingsStore();
  const { settings } = loadSettings(m);
  const ids = Object.keys(settings.providers);
  if (ids.length === 0) {
    ctx.print("No providers registered.\n");
    ctx.print("  Add one: knowns provider add --id ollama --api-base http://localhost:11434/v1\n");
    return;
  }
  let out = `Embedding Providers\n${"─".repeat(50)}\n`;
  // Go ranges over a map, so its order is unspecified; insertion order is as good as any.
  for (const id of ids) {
    const p = settings.providers[id] as (typeof settings.providers)[string];
    let status = "✗ unreachable";
    try {
      await testProviderConnectivity(p.apiBase, p.apiKey ?? "");
      status = "✓ reachable";
    } catch {
      // unreachable
    }
    out += `  ${id} (${p.name})\n`;
    out += `    API Base: ${p.apiBase}\n`;
    out += `    Status:   ${status}\n`;
    const modelCount = Object.values(settings.models).filter((x) => x.provider === id).length;
    if (modelCount > 0) out += `    Models:   ${modelCount}\n`;
    out += "\n";
  }
  ctx.print(out);
}

async function runRemove(ctx: CommandContext): Promise<void> {
  const id = ctx.args[0] as string;
  const m = await settingsStore();
  const { store, settings } = loadSettings(m);
  m.removeProvider(settings, id);
  try {
    store.save(settings);
  } catch (e) {
    throw new Error(`save settings: ${(e as Error).message}`);
  }
  ctx.print(`✓ Provider ${q(id)} removed\n`);
}

async function runTest(ctx: CommandContext): Promise<void> {
  const id = ctx.args[0] as string;
  const m = await settingsStore();
  const { settings } = loadSettings(m);
  const provider = m.getProvider(settings, id);
  ctx.print(`Testing provider ${q(id)} (${provider.apiBase})...\n`);
  try {
    await testProviderConnectivity(provider.apiBase, provider.apiKey ?? "");
  } catch (e) {
    ctx.print(`✗ Connection failed: ${(e as Error).message}\n`);
    throw new Error(`provider ${q(id)} is unreachable`);
  }
  ctx.print(`✓ Provider ${q(id)} is reachable\n`);

  const { APIEmbedder } = await import("../../search/embedder.ts");
  for (const [modelId, model] of Object.entries(settings.models)) {
    if (model.provider !== id) continue;
    ctx.print(`  Testing model ${q(modelId)} (${model.model})...\n`);
    let embedder: InstanceType<typeof APIEmbedder>;
    try {
      embedder = new APIEmbedder({
        apiBase: provider.apiBase,
        apiKey: provider.apiKey ?? "",
        model: model.model,
        dimensions: model.dimensions,
        ...(provider.timeout !== undefined && { timeout: provider.timeout }),
        ...(provider.batchSize !== undefined && { batchSize: provider.batchSize }),
        ...(provider.retry !== undefined && { retry: provider.retry }),
      });
    } catch (e) {
      ctx.print(`    ✗ Config error: ${(e as Error).message}\n`);
      continue;
    }
    if (await embedder.isReachable()) ctx.print(`    ✓ Model available (${model.dimensions}d)\n`);
    else ctx.print("    ✗ Model not available\n");
  }
}

export default defineCommand({
  use: "provider",
  short: "Manage embedding API providers",
  long: "Register, list, remove, and test OpenAI-compatible embedding API providers.",
  subcommands: [
    defineCommand({
      use: "add",
      short: "Register a new embedding provider",
      long: "Register an OpenAI-compatible embedding API provider. Tests connectivity before saving.",
      flags: [
        { type: "string", name: "id", usage: "Provider ID (e.g., ollama, openai)" },
        { type: "string", name: "name", usage: "Display name" },
        {
          type: "string",
          name: "api-base",
          usage: "API base URL (e.g., http://localhost:11434/v1)",
        },
        { type: "string", name: "api-key", usage: "API key (optional for local providers)" },
      ],
      run: runAdd,
    }),
    defineCommand({
      use: "list",
      aliases: ["ls"],
      short: "List registered providers",
      run: runList,
    }),
    defineCommand({
      use: "remove [id]",
      aliases: ["rm"],
      short: "Remove a provider",
      args: exactArgs(1),
      run: runRemove,
    }),
    defineCommand({
      use: "test [id]",
      short: "Health-check a provider",
      args: exactArgs(1),
      run: runTest,
    }),
  ],
});
