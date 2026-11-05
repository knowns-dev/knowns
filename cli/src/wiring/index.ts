// Installs every seam implementation once per process. Called by the root command just before a
// real command loads, so `--version`, help and unknown-command errors never pay for the search,
// runtime and reconciler modules. Each installer is idempotent; the guard only saves the imports.
let installed: Promise<void> | undefined;

export function installWiring(): Promise<void> {
  installed ??= (async () => {
    const [reconciler, runtime] = await Promise.all([
      import("./reconciler.ts"),
      import("./runtime.ts"),
    ]);
    reconciler.installReconciler();
    runtime.installRuntime();
  })();
  return installed;
}
