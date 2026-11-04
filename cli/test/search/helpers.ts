// Shared setup for the search tests: a copy of the Go-written `full` fixture opened through the
// public storage factory, and the environment the search library is given.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SearchEnvironment } from "../../src/search/index.ts";
import { createStorage, type Storage } from "../../src/storage/adapters.ts";
import { Store } from "../../src/storage/core/store.ts";
import { EmbeddingSettingsStore } from "../../src/storage/stores/index.ts";
import { cleanup, copyFixture } from "../history/helpers.ts";

export { cleanup };

export interface SearchFixture {
  dir: string;
  root: string;
  home: string;
  storage: Storage;
  env: SearchEnvironment;
}

/** A private copy of a fixture project plus an isolated machine-level registry under its HOME. */
export function openFixture(
  name: string,
  envVars: Record<string, string | undefined> = {},
  extra: Partial<SearchEnvironment> = {},
): SearchFixture {
  const p = copyFixture(name);
  const globalRoot = join(p.home, ".knowns");
  mkdirSync(globalRoot, { recursive: true });
  const storage = createStorage(Store.open(p.root), { globalRoot });
  const registry = new EmbeddingSettingsStore(join(globalRoot, "settings.json"));
  const env: SearchEnvironment = {
    embeddingRegistry: () => registry.load(),
    env: { KNOWNS_SEMANTIC_RUNTIME_DISABLED: "1", ...envVars },
    sleep: async () => {},
    ...extra,
  };
  return { ...p, storage, env };
}

export function readApi(fixture: string, name: string): unknown {
  return JSON.parse(
    readFileSync(join(import.meta.dir, "..", "fixtures", fixture, "_api", `${name}.json`), "utf8"),
  );
}
