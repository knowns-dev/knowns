// Activity Tray endpoints (spec specs/2026-11-17/activity-tray, "Endpoints"). The registry itself is
// server/operations.ts.
import type { App } from "../app.ts";
import { jsonResponse, type Router, respondError } from "../http.ts";

export function registerOperations(r: Router, app: App): void {
  r.get("/api/operations", () => jsonResponse(200, app.operations.snapshot()));

  r.get("/api/operations/{id}", (c) => {
    const op = app.operations.get(c.params.id as string);
    return op ? jsonResponse(200, { operation: op }) : respondError(404, "operation not found");
  });

  r.post("/api/operations/{id}/cancel", async (c) => {
    const res = await app.operations.cancel(c.params.id as string);
    if (res.status === "unknown") return respondError(404, "operation not found");
    if (res.status === "conflict") {
      return jsonResponse(409, { error: res.error, operation: res.operation });
    }
    return jsonResponse(200, { operation: res.operation });
  });

  r.post("/api/operations/{id}/retry", async (c) => {
    const res = await app.operations.retry(c.params.id as string);
    if (res.status === "unknown") return respondError(404, "operation not found");
    if (res.status === "conflict") return respondError(409, res.error ?? "cannot be retried");
    return jsonResponse(202, { operation: res.operation });
  });

  r.post("/api/operations/{id}/dismiss", (c) => {
    const id = c.params.id as string;
    const res = app.operations.dismiss(id);
    if (res.status === "unknown") return respondError(404, "operation not found");
    if (res.status === "conflict")
      return respondError(409, "only a finished operation can be dismissed");
    return jsonResponse(200, { id });
  });
}
