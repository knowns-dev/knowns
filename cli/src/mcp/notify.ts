// Port of handlers/notify.go. The MCP process tells a running web server about data changes by
// POSTing to http://localhost:<port>/api/notify/... where <port> is the first line of
// <knowledge root>/.server-port. Failures are ignored: the server may not be running.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface NotifyTarget {
  /** store.Root: the knowledge root (.knowns). */
  root: string;
}

export function readServerPort(target: NotifyTarget): string {
  try {
    return readFileSync(join(target.root, ".server-port"), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Fire and forget a POST to /api/<path> with a 2 second timeout. Not in Go: the port must be a
 * plain number and each path segment is percent-encoded, so a planted .server-port ("80@host/x")
 * or a doc path with "..", "?" or "#" cannot send the request to another host or route.
 */
export function notifyServer(target: NotifyTarget, path: string): void {
  const port = readServerPort(target);
  if (!/^\d{1,5}$/.test(port)) return;
  const segments = path.split("/");
  if (segments.some((p) => p === ".." || p === ".")) return;
  const url = `http://localhost:${port}/api/${segments.map(encodeURIComponent).join("/")}`;
  // A setTimeout-driven controller: AbortSignal.timeout never fires under Bun on Windows.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2000);
  fetch(url, { method: "POST", signal: ac.signal })
    .then((res) => res.body?.cancel())
    .catch(() => undefined)
    .finally(() => clearTimeout(timer));
}

export const notifyTaskUpdated = (t: NotifyTarget, taskId: string): void =>
  notifyServer(t, `notify/task/${taskId}`);
export const notifyDocUpdated = (t: NotifyTarget, docPath: string): void =>
  notifyServer(t, `notify/doc/${docPath}`);
export const notifyTimeUpdated = (t: NotifyTarget): void => notifyServer(t, "notify/time");
export const notifyRefresh = (t: NotifyTarget): void => notifyServer(t, "notify/refresh");
