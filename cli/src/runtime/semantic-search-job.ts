// The `semantic-search` runtime job (internal/search/runtime_jobs.go executeRuntimeSemanticSearch),
// so a Go 0.34.1 client sharing a TS daemon of the same version gets its searches answered instead
// of dead-lettered (TSR-2W21YT).
//
// Protocol, as Go's searchWithDaemonRuntime writes it: the client stores a request at
// <runtime root>/semantic-requests/<id>.json and enqueues a `semantic-search` job whose target is
// <id>; the daemon runs the local-runtime search and reports the response as the job's details
// (phase "semantic-search", result = the JSON of RuntimeSearchResponse); the client waits for the
// job, decodes the result, and deletes the request file itself.
//
// The request's `options` is Go's SearchOptions marshalled WITHOUT json tags, so its keys are the
// Go field names (Query, Type, ...); the unexported task snapshot and visibility travel in the
// separate taskSnapshot / hasTaskSnapshot / taskVisibility fields.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Task } from "../models/task.ts";
import type { SearchEnvironment } from "../search/config.ts";
import { shapeRuntime, shapeSearchResult } from "../search/results.ts";
import { searchWithRuntime } from "../search/runtime.ts";
import type { SearchOptions, SearchPurpose, TaskVisibility } from "../search/types.ts";
import type { Storage } from "../storage/adapters.ts";
import { type Job, reportDetails, runtimeRoot } from "./queue.ts";

interface GoSearchOptions {
  Query?: string;
  Type?: string;
  Mode?: string;
  Status?: string;
  Priority?: string;
  Assignee?: string;
  Label?: string;
  Tag?: string;
  Limit?: number;
  IncludeHistorical?: boolean;
  Purpose?: string;
}

interface SemanticSearchRequest {
  options?: GoSearchOptions;
  taskSnapshot?: Task[] | null;
  hasTaskSnapshot?: boolean;
  taskVisibility?: string;
}

export const semanticSearchRequestDir = (): string => join(runtimeRoot(), "semantic-requests");

/** readSemanticSearchRuntimeRequest: the id must be a bare file name, as in Go. */
export function readSemanticSearchRequest(requestId: string): SemanticSearchRequest {
  if (requestId === "" || basename(requestId) !== requestId || requestId.includes("\\")) {
    throw new Error("invalid semantic runtime request id");
  }
  const raw = readFileSync(join(semanticSearchRequestDir(), `${requestId}.json`), "utf8");
  return JSON.parse(raw) as SemanticSearchRequest;
}

/** Go's SearchOptions (field-name keys, zero values for absent fields) as TS options. */
export function searchOptionsFromRequest(req: SemanticSearchRequest): SearchOptions {
  const o = req.options ?? {};
  const opts: SearchOptions = {
    query: o.Query ?? "",
    type: o.Type ?? "",
    mode: o.Mode ?? "",
    status: o.Status ?? "",
    priority: o.Priority ?? "",
    assignee: o.Assignee ?? "",
    label: o.Label ?? "",
    tag: o.Tag ?? "",
    limit: o.Limit ?? 0,
    includeHistorical: o.IncludeHistorical ?? false,
  };
  if (o.Purpose) opts.purpose = o.Purpose as SearchPurpose;
  if (req.hasTaskSnapshot) {
    const snapshot = new Map<string, Task>();
    for (const t of req.taskSnapshot ?? []) if (t) snapshot.set(t.id, t);
    opts.taskSnapshot = snapshot;
    if (req.taskVisibility) opts.taskVisibility = req.taskVisibility as TaskVisibility;
  }
  return opts;
}

/** executeRuntimeSemanticSearch: answer the request and report the response as the job result. */
export async function executeSemanticSearchJob(
  storeRoot: string,
  storage: Storage,
  env: SearchEnvironment,
  job: Job,
): Promise<void> {
  let req: SemanticSearchRequest;
  try {
    req = readSemanticSearchRequest(job.target ?? "");
  } catch (err) {
    throw new Error(`read semantic search request: ${(err as Error).message}`, { cause: err });
  }
  const response = await searchWithRuntime(storage, env, searchOptionsFromRequest(req));
  // json.Marshal(RuntimeSearchResponse): `results` always present, `_runtime` omitted when nil.
  const result: Record<string, unknown> = {
    results: response.results.map((r) => shapeSearchResult(r)),
  };
  if (response.runtime) result._runtime = shapeRuntime(response.runtime);
  reportDetails(storeRoot, job.id, { phase: "semantic-search", result });
}
