// Port of internal/search/ollama_detect.go: probes a running Ollama for its version and the
// embedding-capable models it holds. Every response is a boundary and is parsed with zod.
import { z } from "zod";

export const OLLAMA_DEFAULT_BASE = "http://localhost:11434";
const DETECT_TIMEOUT_MS = 5000;

const versionSchema = z.object({ version: z.string().default("") });
const tagsSchema = z.object({
  models: z
    .array(
      z.object({
        name: z.string(),
        modified_at: z.string().optional(),
        size: z.number().default(0),
      }),
    )
    .nullable()
    .default([]),
});
const showSchema = z.object({
  model_info: z.record(z.string(), z.unknown()).nullable().optional(),
  details: z.looseObject({}).optional(),
  template: z.string().optional(),
});

export type OllamaModel = { name: string; modifiedAt: string; size: number };
export type OllamaModelInfo = z.infer<typeof showSchema>;
export interface OllamaEmbeddingModel {
  name: string;
  /** Without the tag, e.g. "nomic-embed-text". */
  shortName: string;
  dimensions: number;
  size: number;
}

export class OllamaDetector {
  private readonly baseURL: string;

  constructor(
    baseURL = "",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseURL = (baseURL === "" ? OLLAMA_DEFAULT_BASE : baseURL).replace(/\/+$/, "");
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(DETECT_TIMEOUT_MS);
  }

  /** Pings /api/version. */
  async isRunning(): Promise<{ running: boolean; version: string }> {
    try {
      const resp = await this.fetchImpl(`${this.baseURL}/api/version`, { signal: this.signal() });
      if (resp.status !== 200) return { running: false, version: "" };
      const ver = versionSchema.parse(await resp.json());
      return { running: true, version: ver.version };
    } catch {
      return { running: false, version: "" };
    }
  }

  async listModels(): Promise<OllamaModel[]> {
    let resp: Response;
    try {
      resp = await this.fetchImpl(`${this.baseURL}/api/tags`, { signal: this.signal() });
    } catch (err) {
      throw new Error(`list ollama models: ${(err as Error).message}`);
    }
    if (resp.status !== 200) throw new Error(`ollama /api/tags returned HTTP ${resp.status}`);
    let tags: z.infer<typeof tagsSchema>;
    try {
      tags = tagsSchema.parse(await resp.json());
    } catch (err) {
      throw new Error(`parse ollama tags: ${(err as Error).message}`);
    }
    return (tags.models ?? []).map((m) => ({
      name: m.name,
      modifiedAt: m.modified_at ?? "",
      size: m.size,
    }));
  }

  async showModel(name: string): Promise<OllamaModelInfo> {
    let resp: Response;
    try {
      resp = await this.fetchImpl(`${this.baseURL}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
        signal: this.signal(),
      });
    } catch (err) {
      throw new Error(`show ollama model "${name}": ${(err as Error).message}`);
    }
    if (resp.status !== 200)
      throw new Error(`ollama /api/show "${name}" returned HTTP ${resp.status}`);
    try {
      return showSchema.parse(await resp.json());
    } catch (err) {
      throw new Error(`parse ollama show: ${(err as Error).message}`);
    }
  }

  /** The embedding_length from model_info (0 when absent). */
  getEmbeddingDimensions(info: OllamaModelInfo | undefined): number {
    const mi = info?.model_info;
    if (!mi) return 0;
    if (Object.hasOwn(mi, "general.embedding_length")) return toInt(mi["general.embedding_length"]);
    for (const [key, val] of Object.entries(mi)) {
      if (key.includes("embedding_length") || key.includes("embedding.length")) {
        const d = toInt(val);
        if (d > 0) return d;
      }
    }
    return 0;
  }

  isEmbeddingModel(info: OllamaModelInfo | undefined): boolean {
    return info !== undefined && this.getEmbeddingDimensions(info) > 0;
  }

  async listEmbeddingModels(): Promise<OllamaEmbeddingModel[]> {
    const result: OllamaEmbeddingModel[] = [];
    for (const m of await this.listModels()) {
      let info: OllamaModelInfo;
      try {
        info = await this.showModel(m.name);
      } catch {
        continue; // skip models we cannot inspect
      }
      if (!this.isEmbeddingModel(info)) continue;
      const idx = m.name.lastIndexOf(":");
      result.push({
        name: m.name,
        shortName: idx > 0 ? m.name.slice(0, idx) : m.name,
        dimensions: this.getEmbeddingDimensions(info),
        size: m.size,
      });
    }
    return result;
  }
}

function toInt(v: unknown): number {
  return typeof v === "number" ? Math.trunc(v) : 0;
}
