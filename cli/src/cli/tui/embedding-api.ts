// The two OpenAI-compatible endpoint probes the settings flow uses (listAPIModels and
// detectEmbeddingDimensions in internal/cli/config.go).
import { goTransportError } from "../../platform/goerror.ts";

/** fetch with a hard deadline driven by setTimeout (Bun on Windows ignores AbortSignal.timeout under polling). */
async function fetchWithin(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** listAPIModels: the embedding models an endpoint offers, or an Error with Go's wording. */
export async function listApiModels(
  baseUrl: string,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> = {};
  if (apiKey !== "") headers.Authorization = `Bearer ${apiKey}`;
  let resp: Response;
  try {
    resp = await fetchWithin(fetchFn, url, { method: "GET", headers }, 10_000);
  } catch (e) {
    throw new Error(goTransportError("GET", url, e));
  }
  if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
  let body: unknown;
  try {
    body = JSON.parse(await resp.text());
  } catch (e) {
    throw new Error((e as Error).message);
  }
  const data = (body as { data?: unknown }).data;
  const names: string[] = [];
  if (Array.isArray(data)) {
    for (const m of data) {
      const item = m as { id?: unknown; type?: unknown };
      const id = typeof item.id === "string" ? item.id : "";
      const lower = id.toLowerCase();
      if (item.type === "embedding" || lower.includes("embed") || lower.includes("embedding")) {
        names.push(id);
      }
    }
  }
  return names;
}

/** detectEmbeddingDimensions: the vector size of one test embedding, 0 on any failure. */
export async function detectEmbeddingDimensions(
  baseUrl: string,
  apiKey: string,
  model: string,
  say: (line: string) => void,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const url = baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey !== "") headers.Authorization = `Bearer ${apiKey}`;
  let resp: Response;
  try {
    resp = await fetchWithin(
      fetchFn,
      url,
      { method: "POST", headers, body: JSON.stringify({ model, input: "test" }) },
      15_000,
    );
  } catch (e) {
    say(`  Connection error: ${goTransportError("POST", url, e)}`);
    return 0;
  }
  let text: string;
  try {
    text = await resp.text();
  } catch {
    return 0;
  }
  if (resp.status !== 200) {
    let message = "";
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string") message = parsed.error.message;
    } catch {
      message = "";
    }
    say(message !== "" ? `  API error: ${message}` : `  API returned HTTP ${resp.status}`);
    return 0;
  }
  try {
    const parsed = JSON.parse(text) as { data?: Array<{ embedding?: unknown }> };
    const first = parsed.data?.[0];
    return Array.isArray(first?.embedding) ? first.embedding.length : 0;
  } catch {
    return 0;
  }
}
