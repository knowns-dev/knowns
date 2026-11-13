// Installs every seam implementation once per process. Called by the root command just before a
// real command loads, so `--version`, help and unknown-command errors never pay for the search,
// runtime, reconciler and store sync modules. Each installer is idempotent; the guard only saves
// the imports.
let installed: Promise<void> | undefined;

export function installWiring(): Promise<void> {
  installed ??= (async () => {
    const [reconciler, runtime, storesync] = await Promise.all([
      import("./reconciler.ts"),
      import("./runtime.ts"),
      import("./storesync.ts"),
    ]);
    reconciler.installReconciler();
    runtime.installRuntime();
    storesync.installStoreSync();
  })();
  return installed;
}
