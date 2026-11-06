/** Small shared pieces of shell completion; kept apart so startup does not load the scripts. */
import type { CompletionFunc } from "./completion.ts";

export const SHELL_COMP_REQUEST_CMD = "__complete";
export const SHELL_COMP_NO_DESC_REQUEST_CMD = "__completeNoDesc";

export const SHELL_COMP_DIRECTIVE = {
  error: 1,
  noSpace: 2,
  noFileComp: 4,
  filterFileExt: 8,
  filterDirs: 16,
  keepOrder: 32,
  default: 0,
} as const;

/** cobra NoFileCompletions. */
export const noFileCompletions: CompletionFunc = () => [[], SHELL_COMP_DIRECTIVE.noFileComp];

/** cobra configEnvVar: `<NAME>_<SUFFIX>` upper-cased, anything outside [A-Z0-9_] becomes `_`. */
export function configEnvVar(name: string, suffix: string): string {
  return `${name}_${suffix}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

export function activeHelpEnvVar(name: string): string {
  return configEnvVar(name, "ACTIVE_HELP");
}
