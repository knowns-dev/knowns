// Activity Tray endpoints (spec specs/2026-11-17/activity-tray, "Endpoints"). The registry itself is
// server/operations.ts.
import type { App } from "../app.ts";
import { jsonResponse, type Router, respondError } from "../http.ts";

/**
 * The operation id of the path. The router hands over the raw segment when the path was not in
 * Go's canonical encoding, and a client encodes the colon of `job:<id>` as %3A, so decode here.
 */
function idOf(c: { params: Record<string, string> }): string {
  const raw = c.params.id as string;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function registerOperations(r: Router, app: App): void {
  r.get("/api/operations", async () => {
    await app.operations.load();
    return jsonResponse(200, app.operations.snapshot());
  });

  r.get("/api/operations/{id}", (c) => {
    const op = app.operations.get(idOf(c));
    return op ? jsonResponse(200, { operation: op }) : respondError(404, "operation not found");
  });

  r.post("/api/operations/{id}/cancel", async (c) => {
    const res = await app.operations.cancel(idOf(c));
    if (res.status === "unknown") return respondError(404, "operation not found");
    if (res.status === "conflict") {
      return jsonResponse(409, { error: res.error, operation: res.operation });
    }
    return jsonResponse(200, { operation: res.operation });
  });

  r.post("/api/operations/{id}/retry", async (c) => {
    const res = await app.operations.retry(idOf(c));
    if (res.status === "unknown") return respondError(404, "operation not found");
    if (res.status === "conflict") return respondError(409, res.error ?? "cannot be retried");
    return jsonResponse(202, { operation: res.operation });
  });

  // Every finished row (of one project when `projectRoot` is in the body); remembered across restarts.
  r.post("/api/operations/dismiss-finished", async (c) => {
    let projectRoot: string | null = null;
    try {
      const body = (await c.json()) as { projectRoot?: unknown };
      if (typeof body.projectRoot === "string" && body.projectRoot) projectRoot = body.projectRoot;
    } catch {
      // no body: all projects
    }
    await app.operations.load();
    return jsonResponse(200, { ids: app.operations.dismissFinished(projectRoot) });
  });

  r.post("/api/operations/{id}/dismiss", async (c) => {
    const id = idOf(c);
    await app.operations.load();
    const res = app.operations.dismiss(id);
    if (res.status === "unknown") return respondError(404, "operation not found");
    if (res.status === "conflict")
      return respondError(409, "only a finished operation can be dismissed");
    return jsonResponse(200, { id });
  });
}
