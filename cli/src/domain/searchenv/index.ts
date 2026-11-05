// The SearchEnvironment the search library needs, built once for every caller (the CLI search and
// retrieve commands, and later MCP and the HTTP server):
//
//   embeddingRegistry  ~/.knowns/settings.json through EmbeddingSettingsStore (machine level)
//   globalStorage      the machine-level semantic store (~/.knowns/global), searched as the
//                      "global" memory layer; created lazily, only when a search asks for it
//   references         internal/references.Extract, from domain/references
//   queueReindex       the runtime queue seam (see `searchRuntimeHooks`)
//
// Nothing here imports src/cli/core, so MCP and the server can import it without the CLI.

import type { SearchEnvironment } from "../../search/config.ts";
import { createStorage, type Storage } from "../../storage/adapters.ts";
import { Store } from "../../storage/core/store.ts";
import { EmbeddingSettingsStore } from "../../storage/stores/embedding-settings-store.ts";
import { referenceExtractor } from "../references/index.ts";

/**
 * Seams owned by the runtime queue task (TSR-2MPMDK). Until it lands, the queue does not exist in
 * the TypeScript build: `enqueueReindex` is a no-op, exactly what Go's best-effort bootstrap does
 * when the queue write fails (the search never waits for it and never reports its error, and the
 * degraded notice still says "qdrant bootstrap/reindex queued").
 */
export interface SearchRuntimeHooks {
  /** Go: runtimequeue.EnqueueReindex(store.Root). Errors are swallowed by the caller. */
  enqueueReindex: (storeRoot: string) => void | Promise<void>;
}

export const searchRuntimeHooks: SearchRuntimeHooks = {
  enqueueReindex: () => {},
};

export interface BuildSearchEnvironmentOptions {
  /** Process environment (default process.env). */
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Machine settings file (default ~/.knowns/settings.json). */
  settingsPath?: string;
  /** Override the global semantic store (tests). */
  globalStorage?: () => Storage | undefined;
  /** Replaces the queue seam (tests). */
  queueReindex?: (storeRoot: string) => void | Promise<void>;
}

/** The global semantic store as a wired Storage, or undefined when it cannot be opened. */
export function openGlobalSemanticStorage(): Storage | undefined {
  try {
    return createStorage(Store.openGlobalSemantic());
  } catch {
    return undefined;
  }
}

export function buildSearchEnvironment(
  opts: BuildSearchEnvironmentOptions = {},
): SearchEnvironment {
  const registry =
    opts.settingsPath === undefined
      ? new EmbeddingSettingsStore()
      : new EmbeddingSettingsStore(opts.settingsPath);
  let global: Storage | undefined;
  let globalOpened = false;
  const env: SearchEnvironment = {
    embeddingRegistry: () => registry.load(),
    globalStorage:
      opts.globalStorage ??
      (() => {
        if (!globalOpened) {
          globalOpened = true;
          global = openGlobalSemanticStorage();
        }
        return global;
      }),
    references: referenceExtractor,
    queueReindex: opts.queueReindex ?? ((root) => searchRuntimeHooks.enqueueReindex(root)),
  };
  if (opts.env) env.env = opts.env;
  if (opts.fetch) env.fetch = opts.fetch;
  if (opts.sleep) env.sleep = opts.sleep;
  if (opts.now) env.now = opts.now;
  return env;
}
