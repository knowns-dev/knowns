// EmbeddingSettingsStore, registry defaults and semantic resolution
// (embedding_settings_store.go, embedding_registry_defaults.go, semantic_resolve.go).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  D2_DEFAULT_MODEL_ID,
  D2_MODELS,
  OllamaState,
  ollamaStateGuidance,
  recommendedModels,
  resolveSemanticSearch,
  seedDefaults,
} from "../../src/storage/stores/embedding-registry-defaults.ts";
import {
  addModel,
  addProvider,
  type EmbeddingSettings,
  EmbeddingSettingsStore,
  globalSkillsScopeDefault,
  providerWithDefaults,
  removeModel,
  removeProvider,
} from "../../src/storage/stores/embedding-settings-store.ts";
import { goTool } from "./cfg-go.ts";

const tmp = mkdtempSync(join(tmpdir(), "knowns-emb-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const file = (): string => join(tmp, `s${n++}`, "settings.json");

const GO_SEED = `package main

import (
	"fmt"
	"os"

	"github.com/howznguyen/knowns/internal/storage"
)

func main() {
	s := storage.NewEmbeddingSettingsStoreWithPath(os.Args[1])
	if _, err := s.Seed(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
`;

const WITH_EXTRAS = `{
  "futureTopLevel": {"b": 1.50, "a": [1, 2]},
  "defaultEmbeddingModel": "mine",
  "embeddingProviders": {
    "api": {"name": "My API", "apiBase": "https://x/v1", "apiKey": "k<ey>", "region": "eu", "timeout": 10},
    "plain": {"name": "Plain", "apiBase": "http://p/v1"}
  },
  "embeddingModels": {
    "mine": {"provider": "api", "model": "m", "dimensions": 8, "maxTokens": 4, "pooling": "mean"},
    "zero": {"provider": "plain", "model": "z", "dimensions": 0}
  },
  "projectDefaults": {
    "projectName": "dflt",
    "settings": {"defaultTaskIdPrefix": " ab ", "skillsScope": "global", "editor": "vim", "unknownSetting": 3}
  }
}`;

describe("D2 defaults", () => {
  test("table, default id, guidance", () => {
    expect(D2_DEFAULT_MODEL_ID).toBe("qwen3-embedding:0.6b");
    expect(D2_MODELS).toHaveLength(3);
    expect(recommendedModels().map((m) => m.pullCommand)).toEqual([
      "ollama pull qwen3-embedding:0.6b",
      "ollama pull nomic-embed-text",
      "ollama pull all-minilm",
    ]);
    expect(ollamaStateGuidance(OllamaState.ModelMissing, "all-minilm").command).toBe(
      "ollama pull all-minilm",
    );
    expect(ollamaStateGuidance(OllamaState.NotRunning, "").command).toBe("ollama serve");
    expect(ollamaStateGuidance(OllamaState.Ready, "").description).toContain(D2_DEFAULT_MODEL_ID);
  });

  test("seedDefaults never overwrites and is idempotent", () => {
    const s: EmbeddingSettings = {
      providers: { ollama: { name: "mine", apiBase: "x" } },
      models: {},
    };
    expect(seedDefaults(s)).toBe(true);
    expect(s.providers.ollama?.name).toBe("mine");
    expect(Object.keys(s.models)).toHaveLength(3);
    expect(seedDefaults(s)).toBe(false);
    expect(s.providers.api).toBeUndefined();
  });

  test("resolveSemanticSearch resolves local without mutating", () => {
    const input = { enabled: true, model: "m", provider: "local", huggingFaceId: "h" };
    const out = resolveSemanticSearch(input);
    expect(out).toMatchObject({ provider: "ollama", model: D2_DEFAULT_MODEL_ID, dimensions: 1024 });
    expect(out?.huggingFaceId).toBeUndefined();
    expect(input.provider).toBe("local");
    expect(resolveSemanticSearch({ model: "m", provider: "api" })?.provider).toBe("api");
    expect(resolveSemanticSearch(undefined)).toBeUndefined();
  });
});

describe("store", () => {
  test("missing file loads the seeded defaults without writing", () => {
    const f = file();
    const s = new EmbeddingSettingsStore(f).load();
    expect(Object.keys(s.models).sort()).toEqual(D2_MODELS.map((m) => m.id).sort());
    expect(() => readFileSync(f)).toThrow();
  });

  test("seed writes the same bytes as Go's Seed on a fresh machine", () => {
    const tsFile = file();
    new EmbeddingSettingsStore(tsFile).seed();
    const goFile = file();
    const exe = goTool("embseed", GO_SEED);
    if (!exe) return;
    expect(Bun.spawnSync([exe, goFile]).exitCode).toBe(0);
    const ts = readFileSync(tsFile, "utf8");
    expect(ts).toBe(readFileSync(goFile, "utf8"));
    expect(ts.endsWith("\n")).toBe(false);
  });

  test("a file with unknown keys round-trips byte-identically to Go (extras, sorted map output)", () => {
    const tsFile = file();
    const goFile = file();
    const exe = goTool("embseed", GO_SEED);
    for (const f of [tsFile, goFile]) {
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, WITH_EXTRAS);
    }
    const store = new EmbeddingSettingsStore(tsFile);
    store.seed();
    if (!exe) return;
    expect(Bun.spawnSync([exe, goFile]).exitCode).toBe(0);
    expect(readFileSync(tsFile, "utf8")).toBe(readFileSync(goFile, "utf8"));
    const again = store.load();
    expect(again.extra).toBeDefined();
    expect(again.projectDefaults?.settings.defaultTaskIdPrefix).toBe("AB");
  });

  test("a UTF-8 BOM settings.json is read", () => {
    const f = file();
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, `﻿${WITH_EXTRAS}`);
    const s = new EmbeddingSettingsStore(f).load();
    expect(s.providers.api?.apiKey).toBe("k<ey>");
    expect(globalSkillsScopeDefault(new EmbeddingSettingsStore(f))).toBe("global");
  });

  test("invalid project defaults are rejected", () => {
    const f = file();
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, '{"projectDefaults":{"settings":{"defaultTaskIdPrefix":"1!!"}}}');
    expect(() => new EmbeddingSettingsStore(f).load()).toThrow(/normalize project defaults/);
  });
});

describe("settings helpers", () => {
  test("provider/model registration rules", () => {
    const s = new EmbeddingSettingsStore(file()).load();
    expect(() => addProvider(s, "ollama", { name: "x", apiBase: "y" })).toThrow(/already exists/);
    expect(() => addModel(s, "m", { provider: "nope", model: "m", dimensions: 1 })).toThrow(
      /not found; register it first/,
    );
    expect(() => removeProvider(s, "ollama")).toThrow(/still references it/);
    s.defaultEmbeddingModel = "all-minilm";
    expect(() => removeModel(s, "all-minilm")).toThrow(/default embedding model/);
    expect(providerWithDefaults({ name: "a", apiBase: "b" })).toMatchObject({
      timeout: 30,
      batchSize: 64,
      retry: { maxRetries: 3, initialDelay: 1000, maxDelay: 30000 },
    });
  });
});
