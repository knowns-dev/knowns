/**
 * Process-wide extension points owned by other subtasks, so core never imports them.
 * Defaults are inert.
 */
export interface RuntimeHooks {
  /**
   * The background update check (Go util.CheckForUpdate): resolves to the notice to print
   * after a successful command, or "" for none. Wired by the `update` subtask.
   */
  checkForUpdate: (() => Promise<string>) | undefined;
}

export const runtimeHooks: RuntimeHooks = { checkForUpdate: undefined };
