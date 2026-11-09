// Not in Go (rewrite spec D14, @doc/specs/2026-11-07/qdrant-setup-wizard D6): the Qdrant endpoint
// `knowns qdrant setup` picked for this machine. It lives beside the managed runtime, at
// ~/.knowns/runtime/qdrant/endpoint.json, never in `.knowns/`, so a project shared by people on
// different platforms keeps its own vector-store settings and Go 0.34.x still reads it. Go ignores
// the file. Resolution order: env > this file > project config > global settings > defaults.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  ENV_QDRANT_URL,
  ENV_SEMANTIC_QDRANT_URL,
  ENV_SEMANTIC_VECTOR_MODE,
  resolveSemanticVectorStore,
  SEMANTIC_VECTOR_BACKEND_QDRANT,
  SEMANTIC_VECTOR_STORE_MODE_EXTERNAL,
  type SemanticSearchSettings,
  type SemanticVectorStoreResolution,
} from "../models/config.ts";
import { renameOverFile } from "./queue.ts";

/**
 * The QdrantClient URL rules (search/qdrant/client.ts), checked before any request so a URL that
 * search would reject is never probed, recorded or echoed: scheme and host, no credentials, query
 * or fragment, HTTPS unless loopback. Returns the error text, or undefined when the URL is usable.
 */
export function endpointURLError(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return "not a valid URL";
  }
  if (u.host === "") return "the URL needs a scheme and host";
  if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") {
    return "the URL must not carry credentials, a query or a fragment; pass the API key in KNOWNS_QDRANT_API_KEY";
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    return "non-loopback Qdrant endpoints require HTTPS";
  }
  return undefined;
}

export function isLoopbackURL(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export const MACHINE_ENDPOINT_SOURCE_EXISTING = "existing";
export const MACHINE_ENDPOINT_SOURCE_DOCKER = "docker";

const dockerOwnershipSchema = z.object({
  container: z.string().min(1),
  image: z.string().min(1),
  volume: z.string().min(1),
});

export const machineEndpointSchema = z.object({
  version: z.literal(1),
  url: z.string().min(1),
  source: z.enum([MACHINE_ENDPOINT_SOURCE_EXISTING, MACHINE_ENDPOINT_SOURCE_DOCKER]),
  /** Set only when Knowns created the container and may start, stop and remove it. */
  docker: dockerOwnershipSchema.optional(),
  recordedAt: z.string(),
});
export type MachineEndpoint = z.infer<typeof machineEndpointSchema>;
export type DockerOwnership = z.infer<typeof dockerOwnershipSchema>;

type Env = Record<string, string | undefined>;

/**
 * The machine file: beside the managed runtime, so KNOWNS_SEMANTIC_VECTOR_MANAGED_ROOT moves it
 * too; otherwise under the home in `env`. "" when the env names neither (a unit test's injected
 * env never reads the real user's file). It deliberately ignores KNOWNS_RUNTIME_ROOT, which only
 * separates daemon queues: the managed Qdrant, and so the machine's choice of Qdrant, is shared.
 */
export function machineEndpointPath(env: Env = process.env): string {
  const managedRoot = (env.KNOWNS_SEMANTIC_VECTOR_MANAGED_ROOT ?? "").trim();
  if (managedRoot !== "") return join(expandHome(managedRoot, env), "endpoint.json");
  const home = homeOf(env);
  if (home === "") return "";
  return join(home, ".knowns", "runtime", "qdrant", "endpoint.json");
}

function homeOf(env: Env): string {
  return (env.HOME ?? "").trim() || (env.USERPROFILE ?? "").trim();
}

function expandHome(p: string, env: Env): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    const home = homeOf(env);
    if (home !== "") return join(home, p.slice(1));
  }
  return p;
}

/**
 * The recorded endpoint, or undefined when there is none. A file that does not parse is ignored
 * (the project config then applies) rather than failing every search; `knowns doctor` reports it.
 */
export function loadMachineEndpoint(env: Env = process.env): MachineEndpoint | undefined {
  return readMachineEndpoint(env).endpoint;
}

export function readMachineEndpoint(env: Env = process.env): {
  path: string;
  endpoint?: MachineEndpoint;
  error?: string;
} {
  const path = machineEndpointPath(env);
  if (path === "") return { path };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { path };
    return { path, error: (err as Error).message };
  }
  try {
    const parsed = machineEndpointSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return { path, endpoint: parsed.data };
    return { path, error: "unrecognized endpoint file" };
  } catch (err) {
    return { path, error: (err as Error).message };
  }
}

export function saveMachineEndpoint(endpoint: MachineEndpoint, env: Env = process.env): string {
  const path = machineEndpointPath(env);
  if (path === "") throw new Error("cannot record the Qdrant endpoint: no home directory (HOME)");
  machineEndpointSchema.parse(endpoint);
  const invalid = endpointURLError(endpoint.url);
  if (invalid !== undefined) throw new Error(`cannot record the Qdrant endpoint: ${invalid}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(endpoint, null, 2)}\n`, { mode: 0o644 });
  renameOverFile(tmp, path);
  return path;
}

export function removeMachineEndpoint(env: Env = process.env): boolean {
  const path = machineEndpointPath(env);
  if (path === "") return false;
  try {
    rmSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export interface ResolvedVectorStore extends SemanticVectorStoreResolution {
  /** The machine endpoint that supplied externalURL; absent when env or config decided. */
  machineEndpoint?: MachineEndpoint;
}

/**
 * resolveSemanticVectorStore plus the machine file: a recorded endpoint replaces the project and
 * global vector-store target (external mode at its URL) unless KNOWNS_QDRANT_URL or
 * KNOWNS_SEMANTIC_QDRANT_URL is set, or KNOWNS_SEMANTIC_VECTOR_MODE picks a mode. Enabled, opt-out
 * and backend still come from settings, and a non-Qdrant backend ignores the file.
 */
export function resolveVectorStoreForEnv(
  project: SemanticSearchSettings | undefined,
  global: SemanticSearchSettings | undefined,
  env: Env,
): ResolvedVectorStore {
  const lookup = (k: string) => env[k];
  const res: ResolvedVectorStore = resolveSemanticVectorStore(project, global, lookup);
  const envDecides = [ENV_QDRANT_URL, ENV_SEMANTIC_QDRANT_URL, ENV_SEMANTIC_VECTOR_MODE].some(
    (k) => (env[k] ?? "").trim() !== "",
  );
  if (envDecides || res.backend !== SEMANTIC_VECTOR_BACKEND_QDRANT) return res;
  const machine = loadMachineEndpoint(env);
  if (!machine) return res;
  res.externalURL = machine.url;
  res.mode = SEMANTIC_VECTOR_STORE_MODE_EXTERNAL;
  res.machineEndpoint = machine;
  return res;
}
