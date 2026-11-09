// TSR-JGKNSV (spec qdrant-setup-wizard D6, rewrite spec D14): the per-machine Qdrant endpoint file
// and its place in vector-store resolution: env > machine file > project config > global > defaults.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSearchEnvironment } from "../../src/domain/searchenv/index.ts";
import { configFromResolution, QdrantManager } from "../../src/runtime/qdrant.ts";
import {
  loadMachineEndpoint,
  type MachineEndpoint,
  machineEndpointPath,
  readMachineEndpoint,
  removeMachineEndpoint,
  resolveVectorStoreForEnv,
  saveMachineEndpoint,
} from "../../src/runtime/qdrant-endpoint.ts";
import { resolveEffectiveVectorStore } from "../../src/search/config.ts";
import { createStorage } from "../../src/storage/adapters.ts";
import { Store } from "../../src/storage/core/store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "knowns-qdrant-endpoint-"));
  dirs.push(d);
  return d;
}

const DOCKER: MachineEndpoint = {
  version: 1,
  url: "http://127.0.0.1:6333",
  source: "docker",
  docker: {
    container: "knowns-qdrant",
    image: "qdrant/qdrant:v1.14.1",
    volume: "knowns-qdrant-data",
  },
  recordedAt: "2026-11-07T00:00:00.000Z",
};
const EXISTING: MachineEndpoint = {
  version: 1,
  url: "https://qdrant.example:6333",
  source: "existing",
  recordedAt: "2026-11-07T00:00:00.000Z",
};
const managedProject = {
  enabled: true,
  model: "m",
  vectorStore: { backend: "qdrant", mode: "managed" },
};

describe("machine endpoint file", () => {
  test("lives under <home>/.knowns/runtime/qdrant, HOME first, then USERPROFILE", () => {
    expect(machineEndpointPath({ HOME: "/h" })).toBe(
      join("/h", ".knowns", "runtime", "qdrant", "endpoint.json"),
    );
    expect(machineEndpointPath({ USERPROFILE: "C:\\Users\\a" })).toBe(
      join("C:\\Users\\a", ".knowns", "runtime", "qdrant", "endpoint.json"),
    );
    // An injected env that names no home never falls back to the real user's file.
    expect(machineEndpointPath({})).toBe("");
    expect(loadMachineEndpoint({})).toBeUndefined();
  });

  test("save, load and remove round-trip", () => {
    const env = { HOME: tmp() };
    expect(loadMachineEndpoint(env)).toBeUndefined();
    const path = saveMachineEndpoint(DOCKER, env);
    expect(path).toBe(machineEndpointPath(env));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(DOCKER);
    expect(loadMachineEndpoint(env)).toEqual(DOCKER);
    expect(removeMachineEndpoint(env)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(removeMachineEndpoint(env)).toBe(false);
  });

  test("an unreadable or foreign file is ignored and reported, not thrown", () => {
    const env = { HOME: tmp() };
    const path = machineEndpointPath(env);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{not json");
    expect(loadMachineEndpoint(env)).toBeUndefined();
    expect(readMachineEndpoint(env).error).toBeDefined();
    writeFileSync(path, JSON.stringify({ version: 2, url: "x", source: "docker", recordedAt: "" }));
    expect(readMachineEndpoint(env).error).toBe("unrecognized endpoint file");
  });

  test("save refuses an invalid record and an env without a home", () => {
    expect(() => saveMachineEndpoint(DOCKER, {})).toThrow("no home directory");
    expect(() =>
      saveMachineEndpoint({ ...DOCKER, url: "" } as MachineEndpoint, { HOME: tmp() }),
    ).toThrow();
  });
});

describe("resolution order", () => {
  test("the machine file beats a project config that declares managed", () => {
    const env = { HOME: tmp() };
    expect(resolveVectorStoreForEnv(managedProject, undefined, env)).toMatchObject({
      mode: "managed",
      externalURL: "",
    });
    saveMachineEndpoint(EXISTING, env);
    const res = resolveVectorStoreForEnv(managedProject, undefined, env);
    expect(res).toMatchObject({ enabled: true, mode: "external", externalURL: EXISTING.url });
    expect(res.machineEndpoint).toEqual(EXISTING);
  });

  test("the machine file beats a project external URL too", () => {
    const env = { HOME: tmp() };
    saveMachineEndpoint(DOCKER, env);
    const project = {
      enabled: true,
      model: "m",
      vectorStore: {
        backend: "qdrant",
        mode: "external",
        externalURL: "https://team.example:6333",
      },
    };
    expect(resolveVectorStoreForEnv(project, undefined, env).externalURL).toBe(DOCKER.url);
  });

  for (const key of ["KNOWNS_QDRANT_URL", "KNOWNS_SEMANTIC_QDRANT_URL"]) {
    test(`${key} beats the machine file`, () => {
      const env: Record<string, string> = { HOME: tmp(), [key]: "http://env.example:6333" };
      saveMachineEndpoint(DOCKER, env);
      const res = resolveVectorStoreForEnv(managedProject, undefined, env);
      expect(res).toMatchObject({ mode: "external", externalURL: "http://env.example:6333" });
      expect(res.machineEndpoint).toBeUndefined();
    });
  }

  test("KNOWNS_SEMANTIC_VECTOR_MODE beats the machine file", () => {
    const env = { HOME: tmp(), KNOWNS_SEMANTIC_VECTOR_MODE: "managed" };
    saveMachineEndpoint(DOCKER, env);
    expect(resolveVectorStoreForEnv(managedProject, undefined, env)).toMatchObject({
      mode: "managed",
      externalURL: "",
    });
  });

  test("enabled, opt-out and a non-Qdrant backend still come from settings", () => {
    const env = { HOME: tmp() };
    saveMachineEndpoint(DOCKER, env);
    expect(resolveVectorStoreForEnv({ enabled: false, model: "m" }, undefined, env)).toMatchObject({
      enabled: false,
      optedOut: true,
    });
    const sqlite = resolveVectorStoreForEnv(
      { enabled: true, model: "m", vectorStore: { backend: "sqlite" } },
      undefined,
      env,
    );
    expect(sqlite).toMatchObject({ backend: "sqlite", externalURL: "" });
    expect(sqlite.machineEndpoint).toBeUndefined();
  });
});

describe("consumers", () => {
  function project(home: string) {
    const root = join(home, "proj");
    mkdirSync(join(root, ".knowns"), { recursive: true });
    const config = {
      name: "p",
      settings: { semanticSearch: managedProject },
    };
    const configPath = join(root, ".knowns", "config.json");
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    return { root, configPath, before: readFileSync(configPath) };
  }

  test("search and the qdrant runtime use the recorded endpoint; config.json is untouched", () => {
    const home = tmp();
    const env = { HOME: home };
    const p = project(home);
    saveMachineEndpoint(EXISTING, env);
    const storage = createStorage(new Store(join(p.root, ".knowns"), p.root));
    const searchEnv = buildSearchEnvironment({ env, settingsPath: join(home, "settings.json") });
    const res = resolveEffectiveVectorStore(storage, searchEnv);
    expect(res).toMatchObject({ mode: "external", externalURL: EXISTING.url });
    const status = new QdrantManager(configFromResolution(res)).status();
    expect(status.mode).toBe("external");
    expect(status.endpoint).toBe(EXISTING.url);
    expect(readFileSync(p.configPath)).toEqual(p.before);
  });
});
