/**
 * Command registry: the one place a command subtask adds a line.
 *
 * Each entry maps a ROOT command name to a loader for its definition (`export default
 * defineCommand({...})` in a sibling file). The CLI imports a loader only when the arguments
 * select that command (`knowns task ...`, `knowns help task`), so startup cost does not grow
 * with the number of ported commands; root `--help` is rendered from core/help-manifest.generated.ts
 * and needs no module at all.
 *
 *   task: { load: () => import("./task.ts") },
 *
 * A command that is in the 0.34.1 manifest needs nothing else (its summary and help group come
 * from the manifest). A TS-only root command must also give `short` (and `helpGroup`, `hidden`),
 * because root help is rendered before its module is loaded. test/cli/registry.test.ts checks every
 * entry against the manifest.
 *
 * Commands not listed here are "not ported yet": they appear in root help (manifest) but fail
 * honestly when run (see core/root.ts).
 */
import type { CommandSpec } from "../core/define.ts";

export interface CommandLoader {
  load: () => Promise<{ default: CommandSpec }>;
  /** Required only for a command that is not in the manifest. */
  short?: string;
  helpGroup?: string;
  hidden?: boolean;
}

export const commandLoaders: Record<string, CommandLoader> = {
  task: { load: () => import("./task.ts") },
  time: { load: () => import("./time.ts") },
  doc: { load: () => import("./doc.ts") },
  template: { load: () => import("./template.ts") },
  validate: { load: () => import("./validate.ts") },
  memory: { load: () => import("./memory.ts") },
  decision: { load: () => import("./decision.ts") },
};
