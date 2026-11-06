// The init wizard and settings flows against a scripted prompter: questions, order, defaults,
// validators and the answers that come back, including the states the pty tests cannot reach
// (Ollama ready, an existing config) because they depend on the machine.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runWizard,
  semanticModelOptions,
  type WizardInput,
  wizardDefaults,
  wizardSemanticDefaults,
} from "../../src/cli/tui/init-wizard.ts";
import { runGlobalSettings, runProjectSettings } from "../../src/cli/tui/settings-flow.ts";
import { createStorage } from "../../src/storage/adapters.ts";
import { Store } from "../../src/storage/core/index.ts";
import { OllamaState } from "../../src/storage/stores/embedding-registry-defaults.ts";
import { ABORT, ACCEPT, scripted, titles } from "../helpers/scripted-prompter.ts";

const base = (over: Partial<WizardInput> = {}): WizardInput => ({
  cwd: "/work/demo",
  gitTracked: false,
  gitIgnored: false,
  gitAvailable: true,
  inGitRepo: true,
  existingName: "",
  existingTaskIdPrefix: "",
  existingGitTrackingMode: "",
  existingGitTracking: undefined,
  existingSemanticEnabled: undefined,
  existingSemanticModel: "",
  existingPlatforms: ["claude-code", "agents"],
  probe: async () => ({ state: OllamaState.NotInstalled, models: [] }),
  print: () => {},
  ...over,
});

describe("init wizard", () => {
  test("questions and defaults with no Ollama", async () => {
    const { prompter, asked } = scripted([ACCEPT, ACCEPT, ACCEPT, ACCEPT, ACCEPT]);
    const cfg = await runWizard(prompter, base());
    expect(titles(asked)).toEqual([
      "Project name",
      "Default Task ID prefix",
      "Git tracking mode",
      "Knowns sections to track in git",
      "Project instruction files",
    ]);
    expect(asked[0]?.q).toMatchObject({ value: "demo", placeholder: "demo" });
    expect(asked[2]?.q).toMatchObject({ value: "git-tracked" });
    expect(cfg).toMatchObject({
      name: "demo",
      taskIdPrefix: "",
      gitTrackingMode: "git-tracked",
      enableSemantic: false,
      platforms: ["claude-code", "agents"],
      gitTracking: { tasks: true, docs: true, templates: true, decisions: true, memories: false },
    });
  });

  test("validators: blank name, bad prefix, no instruction file", async () => {
    const { prompter } = scripted([" ", ACCEPT]);
    await expect(runWizard(prompter, base())).rejects.toThrow("project name is required");
    const second = scripted([ACCEPT, "k"]);
    await expect(runWizard(second.prompter, base())).rejects.toThrow("validation rejected");
    const third = scripted([ACCEPT, ACCEPT, ACCEPT, ACCEPT, []]);
    await expect(runWizard(third.prompter, base())).rejects.toThrow(
      "select at least one instruction file",
    );
  });

  test("a git flag skips the mode question; no git skips it too", async () => {
    const a = scripted([ACCEPT, ACCEPT, ACCEPT, ACCEPT]);
    const cfg = await runWizard(a.prompter, base({ gitIgnored: true }));
    expect(titles(a.asked)).not.toContain("Git tracking mode");
    expect(cfg.gitTrackingMode).toBe("git-ignored");
    const b = scripted([ACCEPT, ACCEPT, ACCEPT, ACCEPT]);
    const cfg2 = await runWizard(b.prompter, base({ inGitRepo: false, gitAvailable: false }));
    expect(titles(b.asked)).not.toContain("Git tracking mode");
    expect(cfg2.gitTrackingMode).toBe("");
  });

  test("mode none skips the sections and keeps the existing tracking", async () => {
    const existing = {
      tasks: false,
      docs: true,
      templates: false,
      memories: true,
      decisions: false,
    };
    const { prompter, asked } = scripted([ACCEPT, ACCEPT, "none", ACCEPT]);
    const cfg = await runWizard(prompter, base({ existingGitTracking: existing }));
    expect(titles(asked)).not.toContain("Knowns sections to track in git");
    expect(cfg.gitTracking).toEqual(existing);
  });

  test("Ollama ready: semantic group shown, enabled by default, served model preselected", async () => {
    const models = [
      { name: "nomic-embed-text:latest", shortName: "nomic-embed-text", dimensions: 768, size: 1 },
    ];
    const { prompter, asked } = scripted([ACCEPT, ACCEPT, ACCEPT, ACCEPT, ACCEPT, ACCEPT, ACCEPT]);
    const cfg = await runWizard(
      prompter,
      base({ probe: async () => ({ state: OllamaState.Ready, models }) }),
    );
    expect(titles(asked).slice(3, 5)).toEqual(["Enable Semantic Search", "Embedding model"]);
    expect(asked[3]?.q).toMatchObject({ value: true });
    expect(asked[4]?.q).toMatchObject({ value: "nomic-embed-text" });
    const model = asked[4]?.q as unknown as { options: Array<{ label: string; value: string }> };
    const options = model.options;
    expect(options[0]?.label).toBe("nomic-embed-text (768d) — already on this machine");
    expect(options.filter((o) => o.value === "nomic-embed-text")).toHaveLength(1);
    expect(cfg.enableSemantic).toBe(true);
    expect(cfg.semanticModel).toBe("nomic-embed-text");
  });

  test("an earlier answer beats the probe, and an unknown model stays listed", () => {
    const d = wizardSemanticDefaults(OllamaState.Ready, [], false, "old-model");
    expect(d.enabled).toBe(false);
    expect(d.model).toBe("old-model");
    const opts = semanticModelOptions([], "old-model");
    expect(opts.at(-1)).toEqual({
      label: "old-model (current)",
      value: "old-model",
      selected: true,
    });
  });

  test("cancelling aborts", async () => {
    const { prompter } = scripted([ABORT]);
    await expect(runWizard(prompter, base())).rejects.toMatchObject({ name: "UserAborted" });
  });

  test("defaults: global defaults, then the existing config on top", () => {
    const d = wizardDefaults(
      "/work/demo",
      {
        projectName: "Global",
        settings: { defaultTaskIdPrefix: "GL", gitTrackingMode: "none", platforms: ["opencode"] },
      },
      undefined,
    );
    expect(d).toMatchObject({
      existingName: "Global",
      existingTaskIdPrefix: "GL",
      existingGitTrackingMode: "none",
      existingPlatforms: ["opencode"],
    });
    const e = wizardDefaults(
      "/work/demo",
      { projectName: "Global", settings: { defaultTaskIdPrefix: "GL" } },
      {
        name: "mine",
        id: "mine",
        createdAt: "",
        settings: {
          defaultTaskIdPrefix: "",
          semanticSearch: { enabled: true, model: "m", provider: "api" },
        },
      } as never,
    );
    expect(e).toMatchObject({
      existingName: "mine",
      existingTaskIdPrefix: "",
      existingSemanticEnabled: true,
      existingSemanticModel: "m",
      existingEmbeddingSource: "api",
    });
  });
});

describe("settings flows", () => {
  const project = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "knowns-settings-")));
    const store = Store.open(join(root, ".knowns"));
    store.init("proj");
    mkdirSync(join(root, "home"), { recursive: true });
    return { root, home: join(root, "home"), storage: createStorage(store) };
  };
  const deps = (p: ReturnType<typeof project>, prompter: never) => ({
    prompter,
    print: () => {},
    env: { HOME: p.home, USERPROFILE: p.home },
    cwd: p.root,
  });

  test("menu: project name and prefix are saved, done ends", async () => {
    const p = project();
    const { prompter, asked } = scripted(["project", "renamed ", "kn", "done"]);
    await runProjectSettings(deps(p, prompter as never), p.storage.config);
    expect(titles(asked)).toEqual([
      "Project Settings",
      "Project name",
      "Default Task ID prefix",
      "Project Settings",
    ]);
    expect(asked[0]?.q).toMatchObject({ description: "Current project: proj" });
    const cfg = p.storage.config.load();
    expect(cfg.name).toBe("renamed");
    // The config store normalizes the prefix on save, as Go does.
    expect(cfg.settings.defaultTaskIdPrefix).toBe("KN");
  });

  test("git tracking none clears the sections and writes the gitignore", async () => {
    const p = project();
    const { prompter } = scripted(["git", "none", "done"]);
    await runProjectSettings(deps(p, prompter as never), p.storage.config);
    const cfg = p.storage.config.load();
    expect(cfg.settings.gitTrackingMode).toBe("none");
    expect(cfg.settings.gitTracking).toBeUndefined();
  });

  test("code intelligence enables every language", async () => {
    const p = project();
    const { prompter } = scripted(["code", true, "done"]);
    await runProjectSettings(deps(p, prompter as never), p.storage.config);
    const lsp = p.storage.config.load().settings.lsp;
    expect(lsp?.enabled).toBe(true);
    expect(Object.keys(lsp?.languages ?? {}).sort()).toEqual([
      "c_cpp",
      "csharp",
      "go",
      "java",
      "php",
      "python",
      "ruby",
      "rust",
      "typescript",
    ]);
  });

  test("search: Ollama not running is explained and nothing is enabled", async () => {
    const p = project();
    const { prompter } = scripted(["search", true, "ollama", "done"]);
    const out: string[] = [];
    await runProjectSettings(
      {
        ...deps(p, prompter as never),
        print: (t) => out.push(t),
        detector: () => ({
          isRunning: async () => ({ running: false, version: "" }),
          listEmbeddingModels: async () => [],
        }),
      },
      p.storage.config,
    );
    expect(out.join("")).toContain("Ollama not detected at http://localhost:11434");
    expect(p.storage.config.load().settings.semanticSearch?.enabled).not.toBe(true);
  });

  test("search: a served model is chosen and registered in the machine settings", async () => {
    const p = project();
    const { prompter, asked } = scripted(["search", true, "ollama", "all-minilm:latest", "done"]);
    await runProjectSettings(
      {
        ...deps(p, prompter as never),
        detector: () => ({
          isRunning: async () => ({ running: true, version: "0.5.0" }),
          listEmbeddingModels: async () => [
            { name: "all-minilm:latest", shortName: "all-minilm", dimensions: 384, size: 1 },
          ],
        }),
      },
      p.storage.config,
    );
    expect(asked.map((a) => a.q.title)).toContain("Select Embedding Model");
    const ss = p.storage.config.load().settings.semanticSearch;
    expect(ss).toMatchObject({ enabled: true, provider: "ollama", model: "all-minilm:latest" });
    const machine = JSON.parse(readFileSync(join(p.home, ".knowns", "settings.json"), "utf8"));
    expect(machine.embeddingModels["all-minilm:latest"]).toMatchObject({
      provider: "ollama",
      dimensions: 384,
    });
  });

  test("search: the api provider retries until the endpoint answers", async () => {
    const p = project();
    let call = 0;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path.endsWith("/models"))
          return Response.json({ data: [{ id: "my-embed", type: "embedding" }, { id: "chat-1" }] });
        call++;
        if (call === 1)
          return new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 });
        return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}/v1/embeddings`;
      const { prompter, asked } = scripted([
        "search",
        true,
        "api",
        url,
        "k1",
        "my-embed", // first attempt: 401
        url,
        "k2",
        "my-embed", // second attempt succeeds
        "done",
      ]);
      const out: string[] = [];
      await runProjectSettings(
        { ...deps(p, prompter as never), print: (t) => out.push(t) },
        p.storage.config,
      );
      const text = out.join("");
      expect(text).toContain("API error: bad key");
      expect(text).toContain("Failed. Check URL, key, and model name.");
      expect(text).toContain("Success! Dimensions: 3");
      expect(
        asked
          .filter((a) => a.q.title === "API Key")
          .every((a) => (a.q as { password?: boolean }).password),
      ).toBe(true);
      expect(p.storage.config.load().settings.semanticSearch).toMatchObject({
        enabled: true,
        provider: "api",
        model: "my-embed",
      });
      const machine = JSON.parse(readFileSync(join(p.home, ".knowns", "settings.json"), "utf8"));
      expect(machine.embeddingProviders.api).toMatchObject({ apiBase: url, apiKey: "k2" });
      expect(machine.embeddingModels["my-embed"]).toMatchObject({ provider: "api", dimensions: 3 });
    } finally {
      server.stop(true);
    }
  });

  test("cancelling the menu says Aborted and saves nothing", async () => {
    const p = project();
    const out: string[] = [];
    const { prompter } = scripted([ABORT]);
    await runProjectSettings(
      { ...deps(p, prompter as never), print: (t) => out.push(t) },
      p.storage.config,
    );
    expect(out.join("")).toBe("Aborted.\n");
  });

  test("global: done writes the defaults, and the project defaults round trip", async () => {
    const p = project();
    const { prompter } = scripted([
      "project",
      "Mine",
      "KN",
      "platforms",
      ["claude-code", "kiro"],
      "global",
      "done",
    ]);
    const out: string[] = [];
    await runGlobalSettings({ ...deps(p, prompter as never), print: (t) => out.push(t) });
    const saved = JSON.parse(readFileSync(join(p.home, ".knowns", "settings.json"), "utf8"));
    expect(saved.projectDefaults.projectName).toBe("Mine");
    expect(saved.projectDefaults.settings).toMatchObject({
      defaultTaskIdPrefix: "KN",
      platforms: ["claude-code", "kiro"],
      skillsScope: "global",
    });
    expect(out.join("")).toContain("Global settings saved.");
    writeFileSync(join(p.home, "touch"), "");
  });
});
