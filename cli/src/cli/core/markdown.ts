/**
 * Terminal markdown helpers (markdown.go).
 *
 * The width/style selection is ported exactly. The renderer itself is NOT: Go renders with
 * glamour (Charm's markdown engine) and there is no pure-TS equivalent that reproduces its
 * output byte for byte. `newTerminalMarkdownBodyRenderer` therefore takes the same branch Go
 * takes when glamour fails to initialise: the input is returned unchanged. That is the raw
 * (unrendered) body, never wrong text, but it is a known gap for `doc view` on a terminal; see
 * the TSR-TJ8Q3N notes. Callers must keep going through this seam so a real renderer can be
 * dropped in without touching them.
 */
export const MIN_MARKDOWN_RENDER_WIDTH = 20;

export type MarkdownBodyRenderer = (input: string) => string;

export const passthroughMarkdown: MarkdownBodyRenderer = (input) => input;

export function markdownViewportWidth(viewportWidth: number): number {
  const width = viewportWidth - 2;
  return Math.max(width, MIN_MARKDOWN_RENDER_WIDTH);
}

/** The terminal width: the tty size, else $COLUMNS, else 100 (runtime.go terminalWidth). */
export function terminalWidth(env: Record<string, string | undefined> = process.env): number {
  const cols = process.stdout.columns;
  if (typeof cols === "number" && cols > 0) return cols;
  const raw = env.COLUMNS;
  if (raw) {
    const m = /^\s*([+-]?\d+)/.exec(raw);
    const w = m ? Number.parseInt(m[1] ?? "", 10) : 0;
    if (w > 0) return w;
  }
  return 100;
}

export function markdownDisplayWidth(): number {
  return markdownViewportWidth(terminalWidth());
}

/** "ascii" on a dumb terminal, else "dark"/"light". Without a background query we assume dark. */
export function terminalMarkdownStyle(
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.TERM === "dumb") return "ascii";
  return "dark";
}

export function newTerminalMarkdownBodyRenderer(
  _width: number,
  _style: string,
): MarkdownBodyRenderer {
  return passthroughMarkdown;
}
