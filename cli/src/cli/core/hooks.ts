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
  /**
   * The one-line hint for an install that still has the pre-launcher layout (spec mcp-thin-proxy
   * D10): "" or the text to print after a successful command. The hook decides when it is quiet.
   */
  layoutHint: ((argv: string[]) => string) | undefined;
}

export const runtimeHooks: RuntimeHooks = { checkForUpdate: undefined, layoutHint: undefined };
