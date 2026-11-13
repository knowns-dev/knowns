// What every route module shares: the SSE broker, the active project and its wired storage.
import { createStorage, type Storage } from "../storage/adapters.ts";
import type { Manager } from "../storage/core/manager.ts";
import type { Store } from "../storage/core/store.ts";
import type { Registry } from "../storage/stores/registry.ts";
import type { AuthManager } from "./auth.ts";
import { type Ctx, type Handler, respondError } from "./http.ts";
import type { SSEBroker } from "./sse.ts";

export interface ServerOptions {
  dev?: boolean;
  /** Exact extra origins the web server trusts (KNOWNS_ALLOWED_ORIGINS); see cors.ts. */
  allowedOrigins?: string[];
  tunnel?: boolean;
  password?: string;
  allowTaskHardDelete?: boolean;
}

export interface App {
  sse: SSEBroker;
  auth: AuthManager;
  manager: Manager;
  registry: Registry | undefined;
  opts: ServerOptions;
  projectRoot: string;
  port: number;
  /** The initial store the server was started with (Go: Server.store). */
  initialStore: Store | undefined;
  /** The wired storage of the active project, if any. */
  storage(): Storage | undefined;
  /** Same, but throws if there is none (handlers behind requireStore). */
  need(): Storage;
}

const cache = new WeakMap<Store, Storage>();

export function storageFor(store: Store): Storage {
  let s = cache.get(store);
  if (!s) {
    s = createStorage(store);
    cache.set(store, s);
  }
  return s;
}

/** requireStore: 503 when no project is active. */
export function requireStore(app: App, h: Handler): Handler {
  return (c: Ctx) => {
    if (app.manager.getStore() === undefined) return respondError(503, "no active project");
    return h(c);
  };
}
