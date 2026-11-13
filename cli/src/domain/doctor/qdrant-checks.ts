// Port of internal/doctor/qdrant_checks.go: the Qdrant diagnostics. The snapshot carries readiness
// metadata only: never the external URL, an API key, request headers, raw errors or payloads.
import {
  DEFAULT_SEMANTIC_VECTOR_RETENTION_GENERATIONS,
  type SemanticVectorStoreResolution,
} from "../../models/config.ts";
import { parseTaskLifecycleDuration } from "../../models/duration.ts";
import type { QdrantRuntimeStatus } from "../../runtime/qdrant.ts";
import type { QdrantCollectionInfo } from "../../search/qdrant/client.ts";
import type { QdrantGenerationRecord, QdrantPointer } from "../../search/qdrant/pointer.ts";
import type { SemanticIndexReadiness } from "../../search/readiness.ts";
import { skippedForMissingProject } from "./foundation.ts";
import type { LocalState } from "./local.ts";
import type { Checker, CheckOutcome, Evidence } from "./model.ts";

export interface QdrantSnapshot {
  resolution: SemanticVectorStoreResolution & { machineEndpoint?: { url: string; source: string } };
  runtime?: QdrantRuntimeStatus;
  pointer?: QdrantPointer;
  readiness?: SemanticIndexReadiness;
  expected: { model: string; dimensions: number; chunkVersion: number };
  collection?: QdrantCollectionInfo;
  probed: boolean;
  healthy: boolean;
  probeErrorCode: string;
  orphans: string[];
  /**
   * Not in Go (D14): the endpoint `knowns qdrant setup` recorded for this machine, when resolution
   * used it. Only its source and liveness, never the URL.
   */
  machine?: { source: string; answering: boolean; probed: boolean };
  /** The machine endpoint file exists but cannot be read; resolution ignored it. */
  machineFileError?: string;
}

const BACKEND_NONE = "none";
const BACKEND_QDRANT = "qdrant";
const MODE_EXTERNAL = "external";
const STATE_RUNNING = "running";
const STATE_NOT_INSTALLED = "not-installed";

const disabled = (summary: string, reason: string): CheckOutcome => ({
  status: "skip",
  summary,
  skipReason: reason,
});

function qdrantSkip(
  s: QdrantSnapshot,
  off: string,
  notApplicable: string,
): CheckOutcome | undefined {
  const r = s.resolution;
  if (!r.enabled || r.optedOut || r.backend === BACKEND_NONE)
    return disabled(off, "config_disabled");
  if (r.backend !== BACKEND_QDRANT) return disabled(notApplicable, "not_applicable");
  return undefined;
}

// D14 (spec qdrant-setup-wizard FR-12): 0.34.1 ends at the docs reference; the TS build points at
// the setup command last.
const EXTERNAL_ESCAPE =
  " If the managed binary cannot run on this platform, " +
  "configure an external Qdrant endpoint instead: set " +
  "settings.semanticSearch.vectorStore.externalURL and then .mode to external, " +
  "or export KNOWNS_QDRANT_URL (see docs/en/reference/external-qdrant.md), or run `knowns qdrant setup`.";

const DEAD_LETTER_SAMPLE_LIMIT = 10;

function probeErrorCode(s: QdrantSnapshot): string {
  if (s.probeErrorCode !== "") return s.probeErrorCode;
  if (s.runtime?.state === STATE_NOT_INSTALLED) return "qdrant_not_installed";
  if (s.runtime?.state !== STATE_RUNNING) return "qdrant_runtime_not_running";
  if (!s.pointer) return "qdrant_pointer_missing";
  return "qdrant_collection_not_probed";
}

function pointerErrorCode(s: QdrantSnapshot): string {
  const p = s.pointer;
  if (!p) return "qdrant_pointer_missing";
  if (s.expected.model !== "" && p.embedding.model !== s.expected.model)
    return "qdrant_model_mismatch";
  if (s.expected.dimensions > 0 && p.embedding.dimensions !== s.expected.dimensions) {
    return "qdrant_dimensions_mismatch";
  }
  if (s.expected.chunkVersion > 0 && p.chunkVersion !== s.expected.chunkVersion) {
    return "qdrant_chunk_version_mismatch";
  }
  if ((s.readiness?.entityStaleCount ?? 0) > 0) return "qdrant_entities_stale";
  return "qdrant_pointer_invalid";
}

/** qdrantOrphanCandidates: inactive generations beyond retention or past their TTL. */
export function qdrantOrphanCandidates(
  records: QdrantGenerationRecord[],
  active: QdrantPointer | undefined,
  resolution: SemanticVectorStoreResolution,
  currentStoreFingerprint: string,
  now: number = Date.now(),
): string[] {
  const fp = active?.owner.storeRootFingerprint ?? "";
  if (!active || fp === "" || currentStoreFingerprint === "" || fp !== currentStoreFingerprint)
    return [];
  let keep = DEFAULT_SEMANTIC_VECTOR_RETENTION_GENERATIONS;
  if (resolution.retention.previousGenerations !== undefined)
    keep = resolution.retention.previousGenerations;
  // D7 is a hard safety cap, regardless of user-configured retention.
  if (keep > DEFAULT_SEMANTIC_VECTOR_RETENTION_GENERATIONS)
    keep = DEFAULT_SEMANTIC_VECTOR_RETENTION_GENERATIONS;
  let ttlMs = 72 * 3_600_000;
  const raw = (resolution.retention.previousGenerationTTL ?? "").trim();
  if (raw !== "") {
    try {
      ttlMs = Number(parseTaskLifecycleDuration(raw) / 1_000_000n);
    } catch {
      // keep the default
    }
  }
  const seen = new Map<
    string,
    { name: string; generation: number; retired: string | null | undefined }
  >();
  for (const r of records) {
    if (
      r.status !== "inactive" ||
      r.collectionName === "" ||
      r.collectionName === active.collectionName ||
      r.owner.storeRootFingerprint !== fp
    ) {
      continue;
    }
    seen.set(r.collectionName, {
      name: r.collectionName,
      generation: r.generation,
      retired: r.retiredAt,
    });
  }
  const items = [...seen.values()].sort((a, b) =>
    a.generation !== b.generation
      ? b.generation - a.generation
      : a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : 0,
  );
  const out: string[] = [];
  items.forEach((item, i) => {
    const retiredAt = item.retired ? Date.parse(item.retired) : Number.NaN;
    const expired = !Number.isNaN(retiredAt) && now >= retiredAt + ttlMs;
    if (i >= keep || expired) out.push(item.name);
  });
  return out;
}

export function qdrantCheckers(state: LocalState): Checker[] {
  const has = () => state.deps.project !== undefined;
  const snapshot = (signal: AbortSignal) => state.qdrant(signal);
  const checker = (
    id: string,
    body: (s: QdrantSnapshot) => CheckOutcome | Promise<CheckOutcome>,
    off: string,
    notApplicable: string,
  ): Checker => ({
    id,
    scope: "search",
    check: async (signal) => {
      if (!has()) return skippedForMissingProject();
      const s = await snapshot(signal);
      return qdrantSkip(s, off, notApplicable) ?? (await body(s));
    },
  });

  return [
    checker(
      "search.qdrant-runtime",
      (s): CheckOutcome => {
        if (s.machineFileError !== undefined) {
          return {
            status: "warn",
            summary: "The Qdrant endpoint recorded for this machine cannot be read",
            evidence: { recorded: true, readable: false },
            remediation: {
              description: "Record the endpoint again, or forget it.",
              command: "knowns qdrant setup",
            },
          };
        }
        if (s.machine) {
          const docker = s.machine.source === "docker";
          const evidence: Evidence = {
            backend: "qdrant",
            mode: "external",
            recorded: true,
            source: s.machine.source,
            managed: docker,
            healthy: s.machine.answering,
          };
          if (!s.machine.probed) {
            evidence.probed = false;
            delete evidence.healthy;
            return {
              status: "pass",
              summary: `A remote Qdrant is recorded for this machine (${s.machine.source}); offline doctor does not probe it`,
              evidence,
            };
          }
          if (s.machine.answering) {
            return {
              status: "pass",
              summary: `The Qdrant recorded for this machine answers (${s.machine.source})`,
              evidence,
            };
          }
          return {
            status: "warn",
            summary: "The Qdrant recorded for this machine does not answer",
            evidence,
            remediation: docker
              ? {
                  description: "Start the knowns-qdrant Docker container.",
                  command: "knowns qdrant start",
                }
              : {
                  description: "Start that Qdrant, or set up another one.",
                  command: "knowns qdrant setup",
                },
          };
        }
        if (s.resolution.mode === MODE_EXTERNAL) {
          return {
            status: "pass",
            summary: "External Qdrant mode is configured",
            evidence: { backend: "qdrant", mode: "external", managed: false },
          };
        }
        const rt = s.runtime;
        const evidence: Evidence = {
          backend: "qdrant",
          mode: "managed",
          managed: true,
          installed: rt?.installed ?? false,
          state: rt?.state ?? "",
        };
        switch (rt?.state) {
          case STATE_RUNNING:
            evidence.running = true;
            if (!s.healthy) {
              evidence.healthy = false;
              evidence.errorCode = s.probeErrorCode;
              return {
                status: "warn",
                summary: "Managed Qdrant process is running but unhealthy",
                evidence,
                remediation: {
                  description: "Restart the configured managed Qdrant runtime explicitly.",
                  command: "knowns qdrant start",
                },
              };
            }
            evidence.healthy = true;
            return { status: "pass", summary: "Managed Qdrant process is running", evidence };
          case STATE_NOT_INSTALLED:
            return {
              status: "warn",
              summary: "Managed Qdrant binary is not installed",
              evidence,
              remediation: {
                description: `Install the managed Qdrant binary explicitly.${EXTERNAL_ESCAPE}`,
                command: "knowns qdrant install",
              },
            };
          default:
            evidence.running = false;
            return {
              status: "warn",
              summary: "Managed Qdrant process is not healthy",
              evidence,
              remediation: {
                description: `Start the configured managed Qdrant runtime explicitly.${EXTERNAL_ESCAPE}`,
                command: "knowns qdrant start",
              },
            };
        }
      },
      "Qdrant semantic search is intentionally disabled",
      "Qdrant runtime is not applicable to the configured semantic backend",
    ),
    checker(
      "search.qdrant-pointer",
      (s): CheckOutcome => {
        const p = s.pointer;
        if (!p) {
          return {
            status: "warn",
            summary: "Qdrant active collection pointer is missing",
            evidence: { pointer: "missing" },
            remediation: {
              description: "Build and activate a Qdrant generation explicitly.",
              command: "knowns search index --wait",
            },
          };
        }
        const r = s.readiness;
        const evidence: Evidence = {
          pointer: "present",
          actualModel: p.embedding.model,
          actualDimensions: p.embedding.dimensions,
          actualChunkVersion: p.chunkVersion,
          chunkCount: p.chunkCount,
          expectedModel: s.expected.model,
          expectedDimensions: s.expected.dimensions,
          expectedChunkVersion: s.expected.chunkVersion,
        };
        if (r?.entitiesOnlyStale) {
          evidence.ready = true;
          evidence.staleEntities = r.entityStaleCount ?? 0;
          evidence.indexFreshness = "search.project-index";
          return { status: "pass", summary: "Qdrant active pointer is valid", evidence };
        }
        if (!r || r.stale || r.degraded || !r.ready) {
          evidence.ready = false;
          evidence.errorCode = pointerErrorCode(s);
          const reason = (r?.reason ?? "").trim();
          if (reason !== "") evidence.reason = reason;
          if ((r?.entityStaleCount ?? 0) > 0) evidence.staleEntities = r?.entityStaleCount ?? 0;
          return {
            status: "warn",
            summary: "Qdrant active pointer is stale or incomplete",
            evidence,
            remediation: {
              description:
                "Rebuild the active collection for the configured model, dimensions, and chunk version.",
              command: "knowns search index --wait",
            },
          };
        }
        evidence.ready = true;
        return { status: "pass", summary: "Qdrant active pointer is valid", evidence };
      },
      "Qdrant pointer is dormant because semantic search is disabled",
      "Qdrant pointer is not applicable to the configured semantic backend",
    ),
    checker(
      "search.qdrant-collection",
      (s): CheckOutcome => {
        if (s.resolution.mode === MODE_EXTERNAL) {
          return {
            status: "warn",
            summary: "External Qdrant collection is not probed by offline doctor",
            evidence: { mode: "external", probed: false },
            remediation: {
              description:
                "Verify the external Qdrant endpoint, credentials, and active collection manually, then run a blocking reindex if needed.",
            },
          };
        }
        if (!s.probed) {
          let remediation = {
            description: "Start managed Qdrant, then rerun doctor.",
            command: "knowns qdrant start",
          };
          if (s.runtime?.state === STATE_RUNNING && s.healthy) {
            remediation = {
              description: "Rebuild the active collection explicitly, then rerun doctor.",
              command: "knowns search index --wait",
            };
          }
          if (s.runtime?.state === STATE_NOT_INSTALLED) {
            remediation = {
              description: "Install the managed Qdrant binary explicitly.",
              command: "knowns qdrant install",
            };
          }
          return {
            status: "warn",
            summary: "Qdrant collection cannot be inspected",
            evidence: { probed: false, errorCode: probeErrorCode(s) },
            remediation,
          };
        }
        const c = s.collection as QdrantCollectionInfo;
        const evidence: Evidence = {
          probed: true,
          exists: c.exists,
          dimensions: c.dimensions,
          points: c.pointsCount,
          status: c.status,
        };
        if (!c.exists) {
          return {
            status: "warn",
            summary: "Qdrant active collection does not exist",
            evidence,
            remediation: {
              description: "Rebuild and activate the missing collection explicitly.",
              command: "knowns search index --wait",
            },
          };
        }
        if (s.pointer && c.dimensions !== s.pointer.embedding.dimensions) {
          return {
            status: "warn",
            summary: "Qdrant collection dimensions do not match the active pointer",
            evidence,
            remediation: {
              description: "Rebuild the collection with the configured embedding dimensions.",
              command: "knowns search index --wait",
            },
          };
        }
        return {
          status: "pass",
          summary: "Qdrant active collection is present and compatible",
          evidence,
        };
      },
      "Qdrant collection is dormant because semantic search is disabled",
      "Qdrant collection is not applicable to the configured semantic backend",
    ),
    checker(
      "search.qdrant-orphans",
      (s): CheckOutcome => {
        if (s.orphans.length === 0) {
          return {
            status: "pass",
            summary: "No Qdrant orphan collection candidates were identified",
            evidence: { orphanCandidates: 0 },
          };
        }
        return {
          status: "warn",
          summary: "Qdrant orphan collection candidates were identified",
          evidence: { orphanCandidates: s.orphans },
          remediation: {
            description:
              "Review the listed inactive collections and drop the ones you no longer need directly against the Qdrant endpoint. `knowns qdrant cleanup` only clears runtime PID/status metadata and will not remove them.",
          },
        };
      },
      "Qdrant cleanup is dormant because semantic search is disabled",
      "Qdrant cleanup is not applicable to the configured semantic backend",
    ),
    checker(
      "search.qdrant-dead-letters",
      async (): Promise<CheckOutcome> => {
        const { listDeadLetters } = await import("../../runtime/queue.ts");
        const letters = listDeadLetters(
          (state.deps.project as { store: { root: string } }).store.root,
        );
        if (letters.length === 0) {
          return {
            status: "pass",
            summary: "No Qdrant reconcile jobs are stranded in the dead-letter state",
            evidence: { deadLetters: 0 },
          };
        }
        const targets = letters.map((j) => j.target ?? "").sort();
        const evidence: Evidence = {
          deadLetters: letters.length,
          entities: targets.slice(0, DEAD_LETTER_SAMPLE_LIMIT),
        };
        if (letters.length > DEAD_LETTER_SAMPLE_LIMIT) evidence.entitiesTruncated = true;
        return {
          status: "warn",
          summary: `${letters.length} Qdrant reconcile job(s) are dead-lettered and will never be scheduled again`,
          evidence,
          remediation: {
            description:
              "Release the retained jobs back to the scheduler. Preview first with `knowns runtime retry --all --dry-run`, and use `knowns runtime retry --all-projects` when an outage stranded more than this project. Reindexing cannot clear this: the scheduler skips a dead letter unconditionally, so the jobs must be released before the entities behind them can be indexed.",
            command: "knowns runtime retry --all",
          },
        };
      },
      "Qdrant dead-letter recovery is dormant because semantic search is disabled",
      "Qdrant dead-letter recovery is not applicable to the configured semantic backend",
    ),
  ];
}

/** inspectQdrantReadOnly: gather the snapshot; the only network calls are loopback health/collection probes. */
export async function inspectQdrantReadOnly(
  project: { store: { root: string }; storage: import("../../storage/adapters.ts").Storage },
  env: Record<string, string | undefined>,
  signal: AbortSignal,
): Promise<QdrantSnapshot> {
  const { buildSearchEnvironment } = await import("../searchenv/index.ts");
  const { resolveEffectiveVectorStore } = await import("../../search/config.ts");
  const { QdrantManager, configFromResolution } = await import("../../runtime/qdrant.ts");
  const { loadQdrantPointer, loadQdrantGenerations, storeRootFingerprint } = await import(
    "../../search/qdrant/pointer.ts"
  );
  const { resolveSemanticIndexReadiness, semanticIndexExpectationForStore } = await import(
    "../../search/readiness.ts"
  );
  const { CHUNK_VERSION } = await import("../../search/types.ts");

  const searchEnv = buildSearchEnvironment({ env });
  const resolution = resolveEffectiveVectorStore(project.storage, searchEnv);
  const snapshot: QdrantSnapshot = {
    resolution,
    expected: { model: "", dimensions: 0, chunkVersion: 0 },
    probed: false,
    healthy: false,
    probeErrorCode: "",
    orphans: [],
  };
  if (!resolution.enabled || resolution.backend !== BACKEND_QDRANT) return snapshot;
  const { readMachineEndpoint } = await import("../../runtime/qdrant-endpoint.ts");
  const recorded = readMachineEndpoint(env);
  if (recorded.error !== undefined) snapshot.machineFileError = recorded.error;
  if (resolution.machineEndpoint) {
    // Offline doctor only talks to loopback: a recorded remote endpoint is reported, not probed.
    const { probeQdrant, isLoopbackURL } = await import("../../runtime/qdrant-setup.ts");
    const { url, source } = resolution.machineEndpoint;
    if (isLoopbackURL(url)) {
      const p = await probeQdrant(url, "machine", {
        apiKey: (env.KNOWNS_QDRANT_API_KEY ?? "").trim(),
        signal,
      });
      snapshot.machine = { source, answering: p.answering && !p.error, probed: true };
    } else snapshot.machine = { source, answering: false, probed: false };
  }

  const manager = new QdrantManager(configFromResolution(resolution));
  const runtime = manager.status();
  snapshot.runtime = runtime;
  const root = project.store.root;
  const pointer = loadQdrantPointer(root);
  snapshot.pointer = pointer;
  snapshot.readiness = resolveSemanticIndexReadiness(project.storage, searchEnv);
  const exp = semanticIndexExpectationForStore(project.storage, searchEnv);
  snapshot.expected = { model: exp.model, dimensions: exp.dimensions, chunkVersion: CHUNK_VERSION };
  const records = loadQdrantGenerations(root);
  snapshot.orphans = qdrantOrphanCandidates(
    records,
    pointer,
    resolution,
    storeRootFingerprint(root),
  );
  if (resolution.mode !== "managed" || runtime.state !== STATE_RUNNING) return snapshot;

  try {
    await manager.healthCheck(runtime.endpoint ?? "", signal);
  } catch {
    snapshot.probeErrorCode = "qdrant_health_unavailable";
    return snapshot;
  }
  snapshot.healthy = true;
  if (!pointer) return snapshot;
  try {
    const { qdrantClientForStore } = await import("../../search/qdrant/store.ts");
    const client = qdrantClientForStore(project.storage, searchEnv);
    snapshot.collection = await client.inspectCollection(pointer.collectionName);
    snapshot.probed = true;
  } catch {
    snapshot.probeErrorCode = "qdrant_collection_unavailable";
  }
  return snapshot;
}
