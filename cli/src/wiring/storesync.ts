// Wiring for git-backed store sync (TSR-YZY173). Fills the runtime daemon's service seams so the
// TypeScript daemon keeps linked stores in sync in the background exactly as Go's `__runtime run`
// does (internal/cli/runtime.go: storesync.NewService, Services: stores.Run, KeepAlive: HasStores):
//
//   runtimeSeams.services   the store sync loop
//   runtimeSeams.keepAlive  the daemon stays up while any store is linked
//
// Heavy modules load when the daemon actually starts the service, never at CLI startup.
import { join } from "node:path";
import { runtimeSeams } from "../runtime/executor.ts";
import { runtimeRoot } from "../runtime/queue.ts";

let installed = false;

export function installStoreSync(): void {
  if (installed) return;
  installed = true;
  let service: import("../domain/storesync/service.ts").Service | undefined;
  const ready = async () => {
    if (service) return service;
    const { defaultConfig, Service } = await import("../domain/storesync/service.ts");
    const cfg = defaultConfig(join(runtimeRoot(), "stores"));
    cfg.onSynced = async (signal, knowledgeRoot, relPaths) => {
      const { reconcileSynced } = await import("../domain/storesync/reconcile-synced.ts");
      await reconcileSynced(signal, knowledgeRoot, relPaths);
    };
    service = new Service(cfg);
    return service;
  };
  runtimeSeams.services = [
    ...(runtimeSeams.services ?? []),
    async (signal) => {
      await (await ready()).run(signal);
    },
  ];
  const previous = runtimeSeams.keepAlive;
  runtimeSeams.keepAlive = () => {
    if (previous?.()) return true;
    // Before the service object exists no tick has found a store; the registry is the answer.
    return service ? service.hasStores() : false;
  };
}
