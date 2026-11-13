// AC-1 and AC-2: keyword search and retrieval over the Go-written `full` fixture reproduce the
// `search --json` and `retrieve --json` captures byte for byte (key order and float bits included).
import { afterAll, describe, expect, test } from "bun:test";
import { retrieveWithRuntime, searchWithRuntime } from "../../src/search/index.ts";
import { cleanup, openFixture, readApi } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => cleanup(...dirs));

function open() {
  const f = openFixture("full");
  dirs.push(f.dir.replace(/\/project$/, ""));
  return f;
}

describe("keyword search over the full fixture", () => {
  test("search login equals the Go capture", async () => {
    const f = open();
    const out = await searchWithRuntime(f.storage, f.env, {
      query: "login",
      type: "",
      mode: "hybrid",
      limit: 20,
    });
    expect(JSON.stringify(out.results, null, 2)).toBe(
      JSON.stringify(readApi("full", "search.login"), null, 2),
    );
  });

  test("retrieve bun equals the Go capture", async () => {
    const f = open();
    const { response, runtime } = await retrieveWithRuntime(f.storage, f.env, {
      query: "bun",
      mode: "hybrid",
      limit: 20,
    });
    const actual = { ...response, _runtime: runtime };
    expect(JSON.stringify(actual, null, 2)).toBe(
      JSON.stringify(readApi("full", "retrieve.bun"), null, 2),
    );
  });
});
