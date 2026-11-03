import { describe, expect, test } from "bun:test";
import type { SemanticSearchSettings } from "../../src/models/index.ts";
import { resolveSemanticSearch } from "../../src/storage/history/semantic-resolve.ts";

const legacy = (): SemanticSearchSettings => ({
  enabled: true,
  provider: "local",
  model: "multilingual-e5-small",
  huggingFaceId: "Xenova/multilingual-e5-small",
  dimensions: 384,
  maxTokens: 512,
});

describe("resolveSemanticSearch", () => {
  test("undefined in, undefined out", () => {
    expect(resolveSemanticSearch(undefined)).toBeUndefined();
  });

  test("legacy local resolves to ollama D2 default without mutating input", () => {
    const input = legacy();
    const r = resolveSemanticSearch(input);
    expect(r).toMatchObject({
      enabled: true,
      provider: "ollama",
      model: "qwen3-embedding:0.6b",
      dimensions: 1024,
      maxTokens: 32768,
    });
    expect(r?.huggingFaceId).toBeUndefined();
    expect(input).toEqual(legacy());
  });

  test("omitted provider resolves like local", () => {
    const r = resolveSemanticSearch({ model: "", dimensions: 384 });
    expect(r?.provider).toBe("ollama");
    expect(r?.dimensions).toBe(1024);
  });

  test("other providers are returned unchanged as a copy", () => {
    const input: SemanticSearchSettings = { provider: "api", model: "x", dimensions: 8 };
    const r = resolveSemanticSearch(input);
    expect(r).toEqual(input);
    expect(r).not.toBe(input);
  });
});
