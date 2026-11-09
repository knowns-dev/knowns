// Not in Go (rewrite spec D14, @doc/specs/2026-11-07/qdrant-setup-wizard): detection and choice
// behind `knowns qdrant setup`. Detection looks for, in priority order (D1): a Qdrant already
// answering (KNOWNS_QDRANT_URL, else the recorded machine endpoint, else 127.0.0.1:6333), the
// pinned managed artifact for this platform, and a usable Docker. The command layer asks the user
// only when more than one option is valid; everything here is pure over its seams (fetch, docker
// runner, platform, managed status) so tests never touch the real Qdrant or Docker.

import { existsSync } from "node:fs";
import {
  type DockerAvailability,
  type DockerRunner,
  dockerAvailability,
  inspectContainer,
} from "./qdrant-docker.ts";
import { endpointURLError } from "./qdrant-endpoint.ts";
import { currentGoPlatform, qdrantArtifactFor } from "./qdrant-installer.ts";

export { endpointURLError, isLoopbackURL } from "./qdrant-endpoint.ts";

export const SETUP_LOCAL_URL = "http://127.0.0.1:6333";
/** The oldest Qdrant the pinned client is known to work with; any later 1.x is accepted. */
export const MIN_COMPATIBLE_QDRANT = "1.14.0";

export type SetupChoice = "existing" | "managed" | "docker";

export interface ProbeResult {
  url: string;
  /** Where the candidate URL came from. */
  origin: "env" | "machine" | "local";
  answering: boolean;
  version?: string;
  compatible?: boolean;
  error?: string;
}

export interface SetupDetection {
  platform: string;
  /** The first answering, compatible Qdrant; undefined when none. */
  existing?: ProbeResult;
  /** Every candidate probed, for the report. */
  probes: ProbeResult[];
  /** The answering Qdrant on 127.0.0.1:6333 is the managed process Knowns runs. */
  localIsManaged: boolean;
  /** The answering Qdrant on 127.0.0.1:6333 is the knowns-qdrant container. */
  localIsDocker: boolean;
  managed: { available: boolean; reason?: string };
  docker: DockerAvailability;
  /** Valid options, highest priority first. */
  options: SetupChoice[];
}

export interface DetectOptions {
  env: Record<string, string | undefined>;
  /** The loopback endpoint to probe (127.0.0.1:6333 outside tests). */
  localURL?: string;
  /** The recorded machine endpoint URL, when there is one. */
  machineURL?: string;
  /** The machine record is a Docker setup: a local Qdrant is that container, whatever docker says. */
  recordedDocker?: boolean;
  fetch?: typeof fetch;
  docker: DockerRunner;
  goos?: string;
  goarch?: string;
  /** Whether the managed runtime under the managed root reports a live process. */
  managedRunning: () => boolean;
  /** Seam for the musl check on linux/amd64. */
  isMusl?: () => boolean;
  probeTimeoutMs?: number;
}

/** Compares dotted versions numerically; a missing part counts as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function compatibleQdrantVersion(version: string): boolean {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return major === 1 && compareVersions(version, MIN_COMPATIBLE_QDRANT) >= 0;
}

/** GET / answers {"title":"qdrant - vector search engine","version":"x.y.z"}. */
export async function probeQdrant(
  url: string,
  origin: ProbeResult["origin"],
  opts: { fetch?: typeof fetch; apiKey?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<ProbeResult> {
  const invalid = endpointURLError(url);
  if (invalid !== undefined) return { url, origin, answering: false, error: invalid };
  const doFetch = opts.fetch ?? fetch;
  const base = url.replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 1500);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const headers: Record<string, string> = {};
    if (opts.apiKey) headers["api-key"] = opts.apiKey;
    const resp = await doFetch(`${base}/`, { headers, signal: ctrl.signal });
    if (resp.status === 401 || resp.status === 403) {
      return {
        url,
        origin,
        answering: true,
        error: `HTTP ${resp.status}: set KNOWNS_QDRANT_API_KEY for this endpoint`,
      };
    }
    if (!resp.ok) return { url, origin, answering: false, error: `HTTP ${resp.status}` };
    const body = (await resp.json().catch(() => ({}))) as { title?: unknown; version?: unknown };
    if (typeof body.version !== "string" || !String(body.title ?? "").includes("qdrant")) {
      return { url, origin, answering: false, error: "the endpoint is not a Qdrant server" };
    }
    return {
      url,
      origin,
      answering: true,
      version: body.version,
      compatible: compatibleQdrantVersion(body.version),
    };
  } catch (err) {
    const msg = ctrl.signal.aborted ? "no answer" : (err as Error).message;
    return { url, origin, answering: false, error: msg };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

function defaultIsMusl(): boolean {
  return existsSync("/lib/ld-musl-x86_64.so.1") || existsSync("/etc/alpine-release");
}

function sameEndpoint(a: string, b: string): boolean {
  const norm = (u: string) => u.replace(/\/+$/, "").replace("//localhost:", "//127.0.0.1:");
  return norm(a) === norm(b);
}

export async function detectQdrantSetup(opts: DetectOptions): Promise<SetupDetection> {
  const platform = currentGoPlatform();
  const goos = opts.goos ?? platform.goos;
  const goarch = opts.goarch ?? platform.goarch;
  const env = opts.env;
  const envURL =
    (env.KNOWNS_QDRANT_URL ?? "").trim() || (env.KNOWNS_SEMANTIC_QDRANT_URL ?? "").trim();

  const candidates: Array<{ url: string; origin: ProbeResult["origin"] }> = [];
  if (envURL !== "") candidates.push({ url: envURL, origin: "env" });
  else {
    const localURL = opts.localURL ?? SETUP_LOCAL_URL;
    if (opts.machineURL && !sameEndpoint(opts.machineURL, localURL)) {
      candidates.push({ url: opts.machineURL, origin: "machine" });
    }
    candidates.push({ url: localURL, origin: "local" });
  }
  const apiKey = (env.KNOWNS_QDRANT_API_KEY ?? "").trim();
  const [probes, docker] = await Promise.all([
    Promise.all(
      candidates.map((c) =>
        probeQdrant(c.url, c.origin, {
          fetch: opts.fetch,
          apiKey,
          timeoutMs: opts.probeTimeoutMs,
        }),
      ),
    ),
    dockerAvailability(opts.docker),
  ]);

  const local = probes.find((p) => p.origin === "local" && p.answering);
  const localIsManaged = local !== undefined && opts.managedRunning();
  // A slow or stopped Docker daemon must not turn a recorded Docker setup into "existing".
  let localIsDocker = local !== undefined && !localIsManaged && opts.recordedDocker === true;
  if (local && !localIsManaged && !localIsDocker && docker.available) {
    const c = await inspectContainer(opts.docker);
    localIsDocker = c.exists && c.running && c.owned;
  }
  // A local Qdrant that Knowns itself runs is not an "existing" endpoint to record: it stays
  // managed (or Docker-owned), so `qdrant stop` keeps working on it.
  const existing = probes.find(
    (p) =>
      p.answering &&
      p.compatible === true &&
      !(p.origin === "local" && (localIsManaged || localIsDocker)),
  );

  let managed: SetupDetection["managed"];
  if (!qdrantArtifactFor(goos, goarch)) {
    managed = { available: false, reason: `no managed Qdrant build for ${goos}/${goarch}` };
  } else if (goos === "linux" && goarch === "amd64" && (opts.isMusl ?? defaultIsMusl)()) {
    managed = {
      available: false,
      reason: "the managed linux/amd64 build needs glibc; this system uses musl",
    };
  } else managed = { available: true };

  const options: SetupChoice[] = [];
  if (existing) options.push("existing");
  if (managed.available) options.push("managed");
  if (docker.available) options.push("docker");
  return {
    platform: `${goos}/${goarch}`,
    existing,
    probes,
    localIsManaged,
    localIsDocker,
    managed,
    docker,
    options,
  };
}

/**
 * Test seams for the command (like setPrompterFactory): the docker runner, fetch, the loopback
 * endpoint and whether the terminal counts as interactive. Unset in the binary.
 */
export interface SetupSeams {
  docker?: DockerRunner;
  fetch?: typeof fetch;
  localURL?: string;
  interactive?: boolean;
  healthTimeoutMs?: number;
  goos?: string;
  goarch?: string;
}
let seams: SetupSeams = {};
export function setQdrantSetupSeams(next: SetupSeams | undefined): void {
  seams = next ?? {};
}
export function qdrantSetupSeams(): SetupSeams {
  return seams;
}

/** The FR-6 message when nothing can serve Qdrant here. */
export function nothingUsableMessage(d: SetupDetection): string {
  const missing: string[] = [];
  if (d.managed.reason) missing.push(d.managed.reason);
  if (d.docker.reason) missing.push(d.docker.reason);
  for (const p of d.probes) {
    if (p.answering && p.compatible === false) {
      missing.push(`Qdrant ${p.version} at ${p.url} is older than ${MIN_COMPATIBLE_QDRANT}`);
    } else if (p.answering && p.error) missing.push(`${p.url}: ${p.error}`);
  }
  return [
    `no usable Qdrant for semantic search: ${missing.join("; ")}`,
    "Install Docker and rerun `knowns qdrant setup`, or point Knowns at a Qdrant you run: `knowns qdrant setup --url <endpoint>`. Keyword search keeps working meanwhile.",
  ].join("\n");
}
