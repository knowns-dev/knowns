// The doctor library: runner semantics, the network checks against a local server, the Qdrant
// checks over fake snapshots and the import-removal notice. (The command itself is diffed against
// Go in test/cli/commands/doctor.test.ts.)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importsRemovedChecker } from "../../src/domain/doctor/imports.ts";
import { type LocalDeps, localCheckers } from "../../src/domain/doctor/local.ts";
import { type Checker, inactiveProject, run } from "../../src/domain/doctor/model.ts";
import {
  type OnlineDeps,
  onlineCheckers,
  type ProviderTarget,
} from "../../src/domain/doctor/online.ts";
import {
  type QdrantSnapshot,
  qdrantOrphanCandidates,
} from "../../src/domain/doctor/qdrant-checks.ts";
import { createStorage } from "../../src/storage/adapters.ts";
import { Store } from "../../src/storage/core/index.ts";

const opts = { project: inactiveProject() };
const check = (id: string, fn: Checker["check"], timeoutMs?: number): Checker => ({
  id,
  scope: "project",
  check: fn,
  ...(timeoutMs ? { timeoutMs } : {}),
});

describe("runner", () => {
  test("orders by scope then id, derives the verdict and the exit code", async () => {
    const r = await run(opts, [
      { id: "z.b", scope: "ai", check: () => ({ status: "warn", summary: "w" }) },
      { id: "a.a", scope: "ai", check: () => ({ status: "pass", summary: "p" }) },
      { id: "p.p", scope: "project", check: () => ({ status: "skip", summary: "s" }) },
    ]);
    expect(r.checks.map((c) => c.id)).toEqual(["p.p", "a.a", "z.b"]);
    expect(r.summary).toEqual({ pass: 1, warn: 1, fail: 0, skip: 1 });
    expect(r.verdict).toBe("degraded");
    expect(r.checks[2]?.remediation?.description).toContain("rerun knowns doctor");
    expect(r.checks[0]?.skipReason).toBe("not_applicable");
  });

  test("a throwing, slow or lying checker becomes a normalized failure", async () => {
    const r = await run(opts, [
      check("a.throws", () => {
        throw new Error("secret detail");
      }),
      check("b.slow", () => new Promise(() => {}), 20),
      check("c.badstatus", () => ({ status: "meh" as never, summary: "x" })),
      check("d.unsafe", () => ({ status: "pass", summary: "x", evidence: { Bad_Key: 1 } })),
    ]);
    expect(r.checks.map((c) => [c.summary, c.evidence])).toEqual([
      ["Check could not complete", { errorCode: "checker_error" }],
      ["Check timed out", { errorCode: "checker_timeout" }],
      ["Check returned an invalid status", { errorCode: "invalid_status" }],
      ["Check produced unsafe evidence", { errorCode: "unsafe_evidence" }],
    ]);
    expect(r.verdict).toBe("unhealthy");
  });

  test("duplicate ids and unknown scopes are engine errors", async () => {
    await expect(
      run(opts, [
        check("x", () => ({ status: "pass", summary: "" })),
        check("x", () => ({ status: "pass", summary: "" })),
      ]),
    ).rejects.toThrow("duplicate doctor checker ID");
    await expect(run({ ...opts, scopes: ["nope" as never] }, [])).rejects.toThrow(
      "unknown doctor scope",
    );
  });
});

describe("network checks", () => {
  let server: ReturnType<typeof Bun.serve>;
  let versionBody: unknown = { version: "99.0.0" };
  let status = 200;
  let tags: unknown = { models: [{ name: "nomic-embed-text:latest" }] };
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/version")
          return typeof versionBody === "string"
            ? new Response(versionBody)
            : Response.json(versionBody, { status });
        if (path === "/api/tags") return Response.json(tags, { status });
        if (path.endsWith("/embeddings")) return new Response(null, { status });
        return new Response("?", { status: 500 });
      },
    });
  });
  afterAll(() => server.stop(true));
  const url = () => `http://127.0.0.1:${server.port}`;

  const deps = (
    target: ProviderTarget | undefined,
    over: Partial<OnlineDeps> = {},
  ): OnlineDeps => ({
    fetch,
    versionUrl: `${url()}/version`,
    loadProvider: () => target,
    lookPath: () => "/usr/bin/ollama",
    ...over,
  });
  const result = async (d: OnlineDeps, id: string) => {
    const r = await run(
      opts,
      onlineCheckers(d).filter((c) => c.id === id),
    );
    return r.checks[0];
  };
  const target = (over: Partial<ProviderTarget> = {}): ProviderTarget => ({
    id: "prov",
    kind: "api",
    model: "nomic-embed-text",
    apiBase: `${url()}/v1`,
    apiKey: "sk-secret",
    ...over,
  });

  test("online.version: newer, current, bad responses", async () => {
    status = 200;
    versionBody = { version: "99.0.0" };
    expect(await result(deps(undefined), "online.version")).toMatchObject({
      status: "warn",
      summary: "A newer Knowns version is available",
      evidence: { latestVersion: "99.0.0" },
    });
    versionBody = { version: "0.0.1" };
    expect(await result(deps(undefined), "online.version")).toMatchObject({
      status: "pass",
      summary: "Knowns is up to date",
    });
    for (const bad of [{ version: "" }, { version: "not a version" }, "nope"]) {
      versionBody = bad;
      expect(await result(deps(undefined), "online.version")).toMatchObject({
        status: "warn",
        evidence: { errorCode: "version_invalid_response" },
      });
    }
    versionBody = { version: "1.0.0" };
    status = 503;
    expect(await result(deps(undefined), "online.version")).toMatchObject({
      evidence: { errorCode: "version_unexpected_status", statusCode: 503 },
    });
    status = 200;
    expect(
      await result(deps(undefined, { versionUrl: "http://127.0.0.1:1/x" }), "online.version"),
    ).toMatchObject({
      summary: "Version service is unreachable",
      evidence: { errorCode: "network_request_failed" },
    });
  });

  test("search.provider-endpoint: not configured, incomplete, bad url", async () => {
    expect(await result(deps(undefined), "search.provider-endpoint")).toMatchObject({
      status: "skip",
      skipReason: "not_configured",
    });
    const incomplete = deps(undefined, {
      loadProvider: () => {
        throw new Error("x");
      },
    });
    expect(await result(incomplete, "search.provider-endpoint")).toMatchObject({
      status: "warn",
      evidence: { errorCode: "provider_settings_incomplete" },
    });
    expect(
      await result(deps(target({ apiBase: "ftp://x" })), "search.provider-endpoint"),
    ).toMatchObject({ evidence: { errorCode: "provider_url_invalid" } });
    expect(
      await result(deps(target({ apiBase: "http://user:pw@host/v1" })), "search.provider-endpoint"),
    ).toMatchObject({ evidence: { errorCode: "provider_url_invalid" } });
  });

  test("search.provider-endpoint: HTTP statuses map to the documented verdicts", async () => {
    const expected: Array<[number, string, string]> = [
      [200, "pass", ""],
      [401, "fail", "provider_auth_rejected"],
      [403, "fail", "provider_auth_rejected"],
      [404, "fail", "provider_endpoint_missing"],
      [408, "warn", "provider_timeout"],
      [429, "warn", "provider_rate_limited"],
      [500, "fail", "provider_server_error"],
    ];
    for (const [code, st, errorCode] of expected) {
      status = code;
      const r = await result(deps(target()), "search.provider-endpoint");
      expect(r?.status).toBe(st as never);
      if (errorCode) expect(r?.evidence).toMatchObject({ errorCode, statusCode: code });
      // The API key never reaches the output.
      expect(JSON.stringify(r)).not.toContain("sk-secret");
    }
    status = 200;
    const unreachable = await result(
      deps(target({ apiBase: "http://127.0.0.1:1/v1" })),
      "search.provider-endpoint",
    );
    expect(unreachable).toMatchObject({
      status: "warn",
      evidence: { errorCode: "network_request_failed", reachable: false },
    });
  });

  test("search.provider-endpoint: a sensitive-looking provider id gets no command", async () => {
    status = 401;
    const r = await result(deps(target({ id: "my-api-key" })), "search.provider-endpoint");
    expect(r?.remediation?.command).toBeUndefined();
    const ok = await result(deps(target({ id: "prov" })), "search.provider-endpoint");
    expect(ok?.remediation?.command).toBe("knowns provider test prov");
    status = 200;
  });

  test("ollama: not installed, not running, model missing, ready", async () => {
    const ollama = (over: Partial<ProviderTarget> = {}) =>
      target({ kind: "ollama", apiBase: url(), ...over });
    const notInstalled = await result(
      deps(ollama(), { lookPath: () => undefined }),
      "search.provider-endpoint",
    );
    expect(notInstalled).toMatchObject({
      status: "warn",
      summary: "Ollama is not installed",
      evidence: { installed: false },
    });
    const down = await result(
      deps(ollama({ apiBase: "http://127.0.0.1:1" })),
      "search.provider-endpoint",
    );
    expect(down).toMatchObject({
      summary: "Ollama is not serving the configured endpoint",
      evidence: { installed: true, reachable: false },
    });
    tags = { models: [{ name: "other:latest" }] };
    expect(await result(deps(ollama()), "search.provider-endpoint")).toMatchObject({
      summary: "Configured Ollama model is not pulled",
      evidence: { pulled: false },
    });
    tags = { models: [{ name: "Nomic-Embed-Text:latest" }] };
    expect(await result(deps(ollama()), "search.provider-endpoint")).toMatchObject({
      status: "pass",
      evidence: { pulled: true, reachable: true },
    });
    tags = { models: null };
    expect((await result(deps(ollama()), "search.provider-endpoint"))?.summary).toBe(
      "Configured Ollama model is not pulled",
    );
  });
});

describe("local checks over fake dependencies", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "knowns-doctor-")));
  const store = Store.open(join(root, ".knowns"));
  store.init("proj");
  const storage = createStorage(store);
  const project = { store, storage };

  const snapshot = (over: Partial<QdrantSnapshot> = {}): QdrantSnapshot => ({
    resolution: {
      enabled: true,
      optedOut: false,
      backend: "qdrant",
      mode: "managed",
      externalURL: "",
      managedRoot: "",
      install: "",
      retention: {},
    },
    runtime: { state: "running", installed: true } as never,
    expected: { model: "m", dimensions: 3, chunkVersion: 5 },
    probed: false,
    healthy: true,
    probeErrorCode: "",
    orphans: [],
    ...over,
  });
  const deps = (snap: QdrantSnapshot): LocalDeps => ({
    project,
    env: {},
    readiness: () => ({ active: true }) as never,
    embedding: () => [],
    lspStatuses: async () => [],
    lspIds: () => [],
    runtimeHooks: () => [],
    runtimeNames: () => [],
    skillsOutOfSync: () => false,
    globalSkills: () => [],
    globalScope: () => "",
    exists: () => false,
    lookPath: () => undefined,
    readFile: () => "",
    qdrant: async () => snap,
  });
  const qdrant = async (snap: QdrantSnapshot) =>
    (
      await run(
        opts,
        localCheckers(deps(snap)).filter((c) => c.id.startsWith("search.qdrant")),
      )
    ).checks;

  test("disabled and non-qdrant backends skip every check", async () => {
    const off = await qdrant(
      snapshot({ resolution: { ...snapshot().resolution, enabled: false } }),
    );
    expect(off.every((c) => c.status === "skip" && c.skipReason === "config_disabled")).toBe(true);
    const other = await qdrant(
      snapshot({ resolution: { ...snapshot().resolution, backend: "sqlite" } }),
    );
    expect(other.every((c) => c.skipReason === "not_applicable")).toBe(true);
  });

  // D14 (spec qdrant-setup-wizard FR-12, FR-13): the endpoint recorded by `knowns qdrant setup`.
  test("a recorded machine endpoint is reported by source and liveness, never by URL", async () => {
    const byId = async (s: QdrantSnapshot) =>
      Object.fromEntries((await qdrant(s)).map((c) => [c.id, c]));
    const ext = { ...snapshot().resolution, mode: "external" };
    const up = (
      await byId(
        snapshot({ resolution: ext, machine: { source: "docker", answering: true, probed: true } }),
      )
    )["search.qdrant-runtime"];
    expect(up).toMatchObject({
      status: "pass",
      summary: "The Qdrant recorded for this machine answers (docker)",
      evidence: { recorded: true, source: "docker", managed: true, healthy: true },
    });
    expect(JSON.stringify(up)).not.toContain("http");
    const downDocker = (
      await byId(
        snapshot({
          resolution: ext,
          machine: { source: "docker", answering: false, probed: true },
        }),
      )
    )["search.qdrant-runtime"];
    expect(downDocker).toMatchObject({
      status: "warn",
      summary: "The Qdrant recorded for this machine does not answer",
      remediation: { command: "knowns qdrant start" },
    });
    const downExisting = (
      await byId(
        snapshot({
          resolution: ext,
          machine: { source: "existing", answering: false, probed: true },
        }),
      )
    )["search.qdrant-runtime"];
    expect(downExisting?.remediation?.command).toBe("knowns qdrant setup");
    const remote = (
      await byId(
        snapshot({
          resolution: ext,
          machine: { source: "existing", answering: false, probed: false },
        }),
      )
    )["search.qdrant-runtime"];
    expect(remote).toMatchObject({
      status: "pass",
      evidence: { recorded: true, source: "existing", probed: false },
    });
    expect(remote?.summary).toContain("offline doctor does not probe it");
    const unreadable = (await byId(snapshot({ machineFileError: "Unexpected token" })))[
      "search.qdrant-runtime"
    ];
    expect(unreadable).toMatchObject({
      status: "warn",
      summary: "The Qdrant endpoint recorded for this machine cannot be read",
      evidence: { recorded: true, readable: false },
    });
    const missing = (
      await byId(snapshot({ runtime: { state: "not-installed", installed: false } as never }))
    )["search.qdrant-runtime"];
    expect(missing?.remediation?.description?.endsWith("or run `knowns qdrant setup`.")).toBe(true);
  });

  test("managed runtime states", async () => {
    const byId = async (s: QdrantSnapshot) =>
      Object.fromEntries((await qdrant(s)).map((c) => [c.id, c]));
    expect((await byId(snapshot()))["search.qdrant-runtime"]).toMatchObject({
      status: "pass",
      evidence: { running: true, healthy: true },
    });
    expect(
      (await byId(snapshot({ healthy: false, probeErrorCode: "qdrant_health_unavailable" })))[
        "search.qdrant-runtime"
      ],
    ).toMatchObject({
      status: "warn",
      evidence: { healthy: false, errorCode: "qdrant_health_unavailable" },
    });
    const missing = (
      await byId(snapshot({ runtime: { state: "not-installed", installed: false } as never }))
    )["search.qdrant-runtime"];
    expect(missing?.remediation?.command).toBe("knowns qdrant install");
    expect(missing?.remediation?.description).toContain("external Qdrant endpoint");
    const ext = await byId(
      snapshot({ resolution: { ...snapshot().resolution, mode: "external" } }),
    );
    expect(ext["search.qdrant-runtime"]).toMatchObject({
      status: "pass",
      evidence: { mode: "external", managed: false },
    });
    expect(ext["search.qdrant-collection"]).toMatchObject({
      status: "warn",
      evidence: { probed: false, mode: "external" },
    });
  });

  test("pointer: missing, mismatched model, entity-only staleness", async () => {
    const pointer = (model: string) =>
      ({
        embedding: { provider: "", model, dimensions: 3 },
        chunkVersion: 5,
        chunkCount: 9,
        collectionName: "kn_x",
        owner: {},
      }) as never;
    const get = async (s: QdrantSnapshot) =>
      (await qdrant(s)).find((c) => c.id === "search.qdrant-pointer");
    expect(await get(snapshot())).toMatchObject({
      status: "warn",
      evidence: { pointer: "missing" },
    });
    expect(
      await get(
        snapshot({
          pointer: pointer("old"),
          readiness: { ready: false, stale: true, reason: "model changed" } as never,
        }),
      ),
    ).toMatchObject({
      status: "warn",
      evidence: { errorCode: "qdrant_model_mismatch", reason: "model changed" },
    });
    expect(
      await get(
        snapshot({
          pointer: pointer("m"),
          readiness: {
            ready: true,
            stale: true,
            entitiesOnlyStale: true,
            entityStaleCount: 2,
          } as never,
        }),
      ),
    ).toMatchObject({
      status: "pass",
      evidence: { staleEntities: 2, indexFreshness: "search.project-index" },
    });
    expect(
      await get(snapshot({ pointer: pointer("m"), readiness: { ready: true } as never })),
    ).toMatchObject({ status: "pass" });
  });

  test("collection: not probed reasons, missing, dimension mismatch, ok", async () => {
    const get = async (s: QdrantSnapshot) =>
      (await qdrant(s)).find((c) => c.id === "search.qdrant-collection");
    expect(
      await get(snapshot({ runtime: { state: "stopped" } as never, healthy: false })),
    ).toMatchObject({
      evidence: { errorCode: "qdrant_runtime_not_running" },
      remediation: { command: "knowns qdrant start" },
    });
    expect(await get(snapshot())).toMatchObject({
      evidence: { errorCode: "qdrant_pointer_missing" },
      remediation: { command: "knowns search index --wait" },
    });
    const info = (over: object) => ({
      name: "kn_x",
      exists: true,
      dimensions: 3,
      distance: "Cosine",
      status: "green",
      pointsCount: 4,
      ...over,
    });
    const pointer = {
      embedding: { provider: "", model: "m", dimensions: 3 },
      chunkVersion: 5,
      chunkCount: 1,
      collectionName: "kn_x",
      owner: {},
    } as never;
    expect(
      await get(snapshot({ probed: true, collection: info({ exists: false }), pointer })),
    ).toMatchObject({ summary: "Qdrant active collection does not exist" });
    expect(
      await get(snapshot({ probed: true, collection: info({ dimensions: 9 }), pointer })),
    ).toMatchObject({ summary: "Qdrant collection dimensions do not match the active pointer" });
    expect(await get(snapshot({ probed: true, collection: info({}), pointer }))).toMatchObject({
      status: "pass",
      evidence: { points: 4 },
    });
  });

  test("orphan candidates honour retention, the hard cap and the TTL", () => {
    const owner = { storeRootFingerprint: "fp" };
    const active = { collectionName: "kn_active", owner } as never;
    const rec = (name: string, generation: number, retiredAt: string | null, status = "inactive") =>
      ({ collectionName: name, generation, status, retiredAt, owner }) as never;
    const res = { retention: { previousGenerations: 5, previousGenerationTTL: "1h" } } as never;
    const now = Date.parse("2026-01-02T00:00:00Z");
    const recent = "2026-01-01T23:59:00Z";
    const old = "2026-01-01T00:00:00Z";
    const out = qdrantOrphanCandidates(
      [
        rec("g1", 1, recent),
        rec("g2", 2, recent),
        rec("g3", 3, old),
        rec("kn_active", 9, null, "active"),
        { ...(rec("other", 7, old) as object), owner: { storeRootFingerprint: "zz" } } as never,
      ],
      active,
      res,
      "fp",
      now,
    );
    // keep is capped at the default (1): newest g3 is kept unless expired (it is), g2 and g1 are over the cap.
    expect(out.sort()).toEqual(["g1", "g2", "g3"]);
    expect(qdrantOrphanCandidates([rec("g1", 1, recent)], active, res, "different", now)).toEqual(
      [],
    );
    expect(qdrantOrphanCandidates([rec("g1", 1, recent)], undefined, res, "fp", now)).toEqual([]);
  });

  test("dead letters are reported from the queue", async () => {
    const { listDeadLetters } = await import("../../src/runtime/queue.ts");
    expect(listDeadLetters(store.root)).toEqual([]);
    const c = (await qdrant(snapshot())).find((x) => x.id === "search.qdrant-dead-letters");
    expect(c).toMatchObject({ status: "pass", evidence: { deadLetters: 0 } });
  });
});

describe("import removal notice (D8)", () => {
  const mk = (populate: boolean) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "knowns-doctor-imp-")));
    const store = Store.open(join(root, ".knowns"));
    store.init("proj");
    if (populate) {
      mkdirSync(join(store.root, "imports", "pkg"), { recursive: true });
      writeFileSync(join(store.root, "imports", "pkg", "a.md"), "# a\n");
    }
    return { store, storage: createStorage(store) };
  };
  test("no check for a missing or empty imports directory", () => {
    expect(importsRemovedChecker(mk(false))).toBeUndefined();
    expect(importsRemovedChecker(undefined)).toBeUndefined();
  });
  test("a populated imports directory is a warning that says imports stay readable", async () => {
    const checker = importsRemovedChecker(mk(true)) as Checker;
    const r = await run(opts, [checker]);
    expect(r.checks[0]).toMatchObject({
      id: "project.imports",
      status: "warn",
      summary: "Import management was removed; imported content stays readable",
    });
    expect(r.checks[0]?.remediation?.description).toContain("remains readable and searchable");
  });
});
