// Shared by the memory and decision command trees: storage wiring, the search environment for the
// review libraries, the search-index seam, and a few Go-compatible output helpers.
import { readSync } from "node:fs";
import type { SearchEnvironment } from "../../search/config.ts";
import { createStorage, type Storage } from "../../storage/adapters.ts";
import { EmbeddingSettingsStore } from "../../storage/stores/embedding-settings-store.ts";
import type { CommandContext } from "../core/define.ts";
import { StyleDim, StyleInfo, StyleLabel, StyleSuccess } from "../core/plainoutput.ts";

/** The wired storage for the project the command runs in. */
export async function openStorage(ctx: CommandContext): Promise<Storage> {
  return createStorage(await ctx.getStore());
}

/** The environment the review libraries use for their semantic leg. */
export function searchEnvironment(ctx: CommandContext): SearchEnvironment {
  const registry = new EmbeddingSettingsStore();
  return { embeddingRegistry: () => registry.load(), env: ctx.env };
}

/**
 * The seam for search.BestEffortIndex* / BestEffortRemove*. The index writers (generation builder
 * and index service) are not ported yet, so the default does nothing, which is also what the Go
 * binary does for a project without semantic search. A later wave installs the real indexer with
 * setSearchIndexer; every failure is swallowed because indexing is best effort.
 */
export interface SearchIndexer {
  indexMemory(storage: Storage, id: string): void | Promise<void>;
  removeMemory(storage: Storage, id: string): void | Promise<void>;
  indexDecision(storage: Storage, id: string): void | Promise<void>;
}

let indexer: SearchIndexer = {
  indexMemory: () => {},
  removeMemory: () => {},
  indexDecision: () => {},
};

export function setSearchIndexer(next: SearchIndexer): void {
  indexer = next;
}

export async function bestEffortIndexMemory(storage: Storage, id: string): Promise<void> {
  try {
    await indexer.indexMemory(storage, id);
  } catch {
    // best effort
  }
}

export async function bestEffortRemoveMemory(storage: Storage, id: string): Promise<void> {
  try {
    await indexer.removeMemory(storage, id);
  } catch {
    // best effort
  }
}

export async function bestEffortIndexDecision(storage: Storage, id: string): Promise<void> {
  try {
    await indexer.indexDecision(storage, id);
  } catch {
    // best effort
  }
}

export function containsTag(tags: readonly string[] | undefined, tag: string): boolean {
  return (tags ?? []).includes(tag);
}

/** RenderLabels / RenderTags: each tag in magenta, joined by a dim comma. */
export function renderTags(tags: readonly string[]): string {
  if (tags.length === 0) return "";
  return tags.map((t) => StyleLabel.render(t)).join(StyleDim.render(", "));
}

export function layerStyle(layer: string): string {
  switch (layer) {
    case "project":
      return StyleSuccess.render(layer);
    case "global":
      return StyleInfo.render(layer);
    default:
      return layer;
  }
}

/** fmt.Scanln(&answer): the first whitespace-delimited token of one line of stdin ("" on EOF). */
export function scanToken(): string {
  const buf = Buffer.alloc(1);
  let line = "";
  for (;;) {
    let n = 0;
    try {
      n = readSync(0, buf, 0, 1, null);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") continue;
      break;
    }
    if (n === 0) break;
    const ch = buf.toString("utf8");
    if (ch === "\n") break;
    line += ch;
  }
  return line.trim().split(/\s+/u)[0] ?? "";
}

/** Go's time.RFC3339 for a stored UTC timestamp: no fractional seconds. */
export function rfc3339(ts: string): string {
  return ts.replace(/\.\d+Z$/, "Z");
}
