// Differential test: the TypeScript keyword search against the real Go 0.34.1 binary over a
// synthetic corpus. Scores are compared as printed JSON, so every float bit and every tie-break
// has to agree. Skipped when no Go binary is available (set KNOWNS_GO_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { retrieveWithRuntime, searchWithRuntime } from "../../src/search/index.ts";
import { createStorage, type Storage } from "../../src/storage/adapters.ts";
import { Store } from "../../src/storage/core/store.ts";
import { EmbeddingSettingsStore } from "../../src/storage/stores/index.ts";
import { cleanup, hasGo } from "../history/helpers.ts";
import { buildCorpus, type GoProject, newGoProject, QUERIES } from "./go-corpus.ts";

const suite = hasGo() ? describe : describe.skip;

suite("keyword search against Go 0.34.1", () => {
  let go: GoProject;
  let storage: Storage;
  const env = { KNOWNS_SEMANTIC_RUNTIME_DISABLED: "1" };

  beforeAll(() => {
    go = newGoProject();
    buildCorpus(go);
    storage = createStorage(Store.open(join(go.project, ".knowns")), {
      globalRoot: join(go.home, ".knowns"),
    });
  }, 120_000);
  afterAll(() => cleanup(join(go.project, "..")));

  const searchEnv = () => ({
    embeddingRegistry: () =>
      new EmbeddingSettingsStore(join(go.home, ".knowns", "settings.json")).load(),
    env,
  });

  const goJson = (args: string[]) => {
    const r = go.run([...args, "--json"], env);
    expect(r.code, r.stderr).toBe(0);
    return r.stdout.trim();
  };

  for (const q of QUERIES) {
    for (const flags of [
      [],
      ["--keyword"],
      ["--limit", "5"],
      ["--type", "doc"],
      ["--type", "task", "--include-historical"],
    ]) {
      test(`search ${JSON.stringify(q)} ${flags.join(" ")}`, async () => {
        const type = flags.includes("--type") ? (flags[flags.indexOf("--type") + 1] as string) : "";
        const limit = flags.includes("--limit") ? Number(flags[flags.indexOf("--limit") + 1]) : 20;
        const out = await searchWithRuntime(storage, searchEnv(), {
          query: q,
          type,
          mode: flags.includes("--keyword") ? "keyword" : "hybrid",
          limit,
          includeHistorical: flags.includes("--include-historical"),
        });
        const expected = goJson(["search", q, ...flags]);
        expect(JSON.stringify(out.results, null, 2)).toBe(
          JSON.stringify(JSON.parse(expected), null, 2),
        );
      });
    }

    test(`retrieve ${JSON.stringify(q)}`, async () => {
      const { response, runtime } = await retrieveWithRuntime(storage, searchEnv(), {
        query: q,
        mode: "hybrid",
        limit: 20,
      });
      const actual = runtime ? { ...response, _runtime: runtime } : response;
      const expected = goJson(["retrieve", q]);
      expect(JSON.stringify(actual, null, 2)).toBe(JSON.stringify(JSON.parse(expected), null, 2));
    });
  }

  // The simple reference forms the corpus uses; the real extractor (internal/references) is not
  // ported yet and is injected into the library.
  const references = {
    extract: (content: string) => {
      const refs: {
        raw: string;
        canonical: string;
        type: string;
        target: string;
        relation: string;
        validRelation: boolean;
      }[] = [];
      for (const m of content.matchAll(/@doc\/([A-Za-z0-9._/-]*[A-Za-z0-9])/g)) {
        refs.push({
          raw: m[0],
          canonical: m[0],
          type: "doc",
          target: m[1] as string,
          relation: "references",
          validRelation: true,
        });
      }
      for (const m of content.matchAll(/@task-([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/g)) {
        refs.push({
          raw: m[0],
          canonical: m[0],
          type: "task",
          target: m[1] as string,
          relation: "references",
          validRelation: true,
        });
      }
      return refs;
    },
  };

  for (const q of ["see", "rollback", "release", "login auth"]) {
    for (const extra of [[], ["--include-historical"], ["--source-types", "task"]]) {
      test(`retrieve --expand-references ${JSON.stringify(q)} ${extra.join(" ")}`, async () => {
        const sourceTypes = extra.includes("--source-types") ? ["task"] : undefined;
        const { response, runtime } = await retrieveWithRuntime(
          storage,
          { ...searchEnv(), references },
          {
            query: q,
            mode: "hybrid",
            limit: 20,
            expandReferences: true,
            includeHistorical: extra.includes("--include-historical"),
            sourceTypes,
          },
        );
        const actual = runtime ? { ...response, _runtime: runtime } : response;
        const expected = goJson(["retrieve", q, "--expand-references", ...extra]);
        expect(JSON.stringify(actual, null, 2)).toBe(JSON.stringify(JSON.parse(expected), null, 2));
        // the corpus has cross references, so at least one query must really expand something
        if (q === "see" && extra.length === 0) {
          expect((response.candidates ?? []).some((c) => !c.directMatch)).toBe(true);
        }
      });
    }
  }

  test("semantic search not configured: keyword results with the not_configured notice", async () => {
    // The runtime is enabled here (no KNOWNS_SEMANTIC_RUNTIME_DISABLED), but the project has no
    // semantic settings, so the preflight degrades before any service is contacted.
    const enabled = () => ({
      embeddingRegistry: () =>
        new EmbeddingSettingsStore(join(go.home, ".knowns", "settings.json")).load(),
      env: {},
    });
    const out = await searchWithRuntime(storage, enabled(), {
      query: "login auth",
      type: "",
      mode: "hybrid",
      limit: 20,
    });
    expect(out.runtime).toEqual({
      degraded: true,
      mode: "hybrid",
      reason: "not_configured",
      message:
        "semantic runtime unavailable; returned keyword results only: semantic search not configured or disabled",
    });
    const r = go.run(["search", "login auth", "--json"], {});
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.stringify(out.results, null, 2)).toBe(
      JSON.stringify(JSON.parse(r.stdout), null, 2),
    );
  });
});
