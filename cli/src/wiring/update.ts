// Wires the background update check (Go util.CheckForUpdate) into the root command: after a
// successful command it prints " UPDATE  vX available" when the npm registry has a newer version.
// `execute` already skips it for --plain/--json/update, CI and NO_UPDATE_CHECK=1.
import { runtimeHooks } from "../cli/core/hooks.ts";

export function installUpdateNotifier(): void {
  runtimeHooks.checkForUpdate = async () => {
    const { checkForUpdate } = await import("../domain/update/notifier.ts");
    return checkForUpdate(process.env);
  };
}
