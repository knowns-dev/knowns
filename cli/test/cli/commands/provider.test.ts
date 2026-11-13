// `knowns provider` against the Go 0.34.1 oracle: output, exit code and the ~/.knowns/settings.json
// each command leaves behind, with a local stub standing in for the embedding API (a 4xx counts as
// reachable, a 5xx does not, a closed port is refused).
//
// Go ranges over maps for `list` and for the models `test` checks, so its order is unspecified
// once there are two entries. The cases keep one provider in a list and one model per tested
// provider. Every registry is seeded with an `ollama` provider, so `list` points that one at the
// stub. The flagless `add` probes a real Ollama on localhost and is not run here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasGoBin } from "../oracle.ts";
import { makeSandbox, runGoIn, runTsIn, type Sandbox } from "./subprocess-diff.ts";

const t = test.skipIf(!hasGoBin);

let server: ReturnType<typeof Bun.serve> | undefined;
let base = "";
const boxes: Sandbox[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/bad")) return new Response("boom", { status: 503 });
      if (path.endsWith("/embeddings")) {
        const body = (await req.json().catch(() => ({}))) as { model?: string; input?: string[] };
        if (body.model === "test")
          return Response.json({ error: "unknown model" }, { status: 400 });
        const n = (body.input ?? []).length;
        return Response.json({
          data: Array.from({ length: n }, (_, index) => ({ index, embedding: [0.1, 0.2, 0.3] })),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  for (const b of boxes) rmSync(b.root, { recursive: true, force: true });
});

/** A sandbox whose settings.json holds `providers` and `models` (or no file at all). */
function box(settings?: { providers?: object; models?: object }): Sandbox {
  const b = makeSandbox("knowns-provider-");
  boxes.push(b);
  mkdirSync(b.proj, { recursive: true });
  mkdirSync(join(b.home, ".knowns"), { recursive: true });
  if (settings) {
    writeFileSync(
      join(b.home, ".knowns", "settings.json"),
      JSON.stringify({
        embeddingProviders: settings.providers ?? {},
        embeddingModels: settings.models ?? {},
      }),
    );
  }
  return b;
}

async function same(b: Sandbox, args: string[]): Promise<void> {
  const opts = { watch: ["home/.knowns/settings.json"] };
  const go = await runGoIn(b, args, opts);
  const ts = await runTsIn(b, args, opts);
  expect(ts).toEqual(go);
}

const ollamaAt = (apiBase: string) => ({ ollama: { name: "Ollama Local", apiBase } });
const stubWithModel = () => ({
  providers: { stub: { name: "Stub", apiBase: `${base}/v1` } },
  models: { m1: { provider: "stub", model: "stub-embed", dimensions: 3 } },
});

describe("provider list matches Go", () => {
  t("reachable", () => same(box({ providers: ollamaAt(`${base}/v1`) }), ["provider", "list"]));
  t("server error is unreachable", () =>
    same(box({ providers: ollamaAt(`${base}/bad`) }), ["provider", "ls"]),
  );
  t("refused is unreachable", () =>
    same(box({ providers: ollamaAt("http://127.0.0.1:1/v1") }), ["provider", "list", "--plain"]),
  );
});

describe("provider add matches Go", () => {
  t("registers and saves", () =>
    same(box(), ["provider", "add", "--id", "stub", "--api-base", `${base}/v1`]),
  );
  t("with name and key", () =>
    same(box(), [
      "provider",
      "add",
      "--id",
      "stub",
      "--name",
      "Stub",
      "--api-base",
      `${base}/v1`,
      "--api-key",
      "sk-1",
    ]),
  );
  t("an Ollama-looking name lists models when it can", () =>
    same(box(), [
      "provider",
      "add",
      "--id",
      "local",
      "--name",
      "My Ollama",
      "--api-base",
      `${base}/v1`,
    ]),
  );
  t("server error is not saved", () =>
    same(box(), ["provider", "add", "--id", "bad", "--api-base", `${base}/bad`]),
  );
  t("refused is not saved", () =>
    same(box(), ["provider", "add", "--id", "down", "--api-base", "http://127.0.0.1:1/v1"]),
  );
  t("an existing id", () =>
    same(box(), ["provider", "add", "--id", "ollama", "--api-base", `${base}/v1`]),
  );
  t("--id missing", () => same(box(), ["provider", "add", "--api-base", `${base}/v1`]));
  t("--api-base missing", () => same(box(), ["provider", "add", "--id", "x"]));
});

describe("provider remove matches Go", () => {
  t("removes", () =>
    same(box({ providers: { spare: { name: "Spare", apiBase: `${base}/v1` } } }), [
      "provider",
      "remove",
      "spare",
    ]),
  );
  t("rm alias", () =>
    same(box({ providers: { spare: { name: "Spare", apiBase: `${base}/v1` } } }), [
      "provider",
      "rm",
      "spare",
    ]),
  );
  t("a model still references it", () =>
    same(box(stubWithModel()), ["provider", "remove", "stub"]),
  );
  t("unknown", () => same(box(), ["provider", "remove", "nope"]));
  t("argument count", () => same(box(), ["provider", "rm"]));
});

describe("provider test matches Go", () => {
  t("reachable with an available model", () =>
    same(box(stubWithModel()), ["provider", "test", "stub"]),
  );
  t("unreachable", () =>
    same(box({ providers: { down: { name: "Down", apiBase: "http://127.0.0.1:1/v1" } } }), [
      "provider",
      "test",
      "down",
    ]),
  );
  t("unknown", () => same(box(), ["provider", "test", "nope"]));
  t("argument count", () => same(box(), ["provider", "test"]));
});

describe("provider help matches Go", () => {
  for (const args of [
    ["provider"],
    ["provider", "--help"],
    ["provider", "add", "--help"],
    ["provider", "list", "--help"],
    ["provider", "remove", "--help"],
    ["provider", "test", "--help"],
  ]) {
    t(args.join(" "), () => same(box(), args));
  }
});
