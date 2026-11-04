/**
 * Styling and the plain-output switch (styles.go + plainoutput.go).
 *
 * Go swaps every package-level lipgloss style for a blank one. A TS Style is a value that checks
 * the switch when it renders, which gives the same single choke point without mutating shared
 * state: `setPlainOutput(true)` and every `StyleX.render(...)` call site is covered.
 *
 * lipgloss is only ever used here with foreground colour and bold, so the escape sequences are
 * written directly: `ESC[1m`, `ESC[36m`, `ESC[1;36m`, reset `ESC[m`. Each line of a multi-line
 * string is wrapped on its own, as lipgloss does.
 */

let plain = false;

/** Reports whether ANSI styling is suppressed for this invocation. */
export function plainOutput(): boolean {
  return plain;
}

/** Turns ANSI styling off (or back on) for the whole CLI. */
export function setPlainOutput(on: boolean): void {
  plain = on;
}

/** NO_COLOR convention: set and non-empty, whatever the value. */
export function noColorRequested(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.NO_COLOR;
  return v !== undefined && v !== "";
}

/** ANSI 256-colour palette indexes the CLI uses (lipgloss.Color("2") and friends). */
const FG = {
  green: 32,
  red: 31,
  yellow: 33,
  cyan: 36,
  blue: 34,
  magenta: 35,
  purple: 95,
  gray: 90,
};

export class Style {
  constructor(
    private readonly bold: boolean,
    private readonly fg: number | undefined,
  ) {}

  /** The same style with bold added. */
  withBold(): Style {
    return new Style(true, this.fg);
  }

  render(text: string): string {
    if (plain || (!this.bold && this.fg === undefined)) return text;
    const codes = [
      ...(this.bold ? ["1"] : []),
      ...(this.fg === undefined ? [] : [String(this.fg)]),
    ];
    const open = `\x1b[${codes.join(";")}m`;
    return text
      .split("\n")
      .map((line) => (line === "" ? line : `${open}${line}\x1b[m`))
      .join("\n");
  }
}

export const StyleSuccess = new Style(false, FG.green);
export const StyleError = new Style(false, FG.red);
export const StyleWarning = new Style(false, FG.yellow);
export const StyleInfo = new Style(false, FG.cyan);
export const StyleDim = new Style(false, FG.gray);
export const StyleBold = new Style(true, undefined);
export const StyleTitle = new Style(true, FG.cyan);
export const StyleID = new Style(false, FG.cyan);
export const StyleLabel = new Style(false, FG.magenta);
export const StyleKey = new Style(true, undefined);

/** Colour for a status, mirroring StatusStyle; the default foreground for "todo". */
export function statusStyle(status: string): Style {
  switch (status) {
    case "done":
      return StyleSuccess;
    case "in-progress":
      return StyleInfo;
    case "in-review":
      return new Style(false, FG.blue);
    case "blocked":
      return StyleError;
    case "on-hold":
      return StyleWarning;
    case "urgent":
      return new Style(true, FG.red);
    default:
      return new Style(false, undefined);
  }
}

/** Colour for a priority, mirroring PriorityStyle. */
export function priorityStyle(priority: string): Style {
  switch (priority) {
    case "high":
      return StyleError;
    case "low":
      return new Style(false, undefined);
    default:
      return StyleWarning;
  }
}

// Render helpers shared by every command (styles.go "Render helpers").
export const renderSuccess = (msg: string): string => StyleSuccess.render(`✓ ${msg}`);
export const renderError = (msg: string): string => StyleError.render(`✗ ${msg}`);
export const renderWarning = (msg: string): string => StyleWarning.render(`⚠ ${msg}`);
export const renderInfo = (msg: string): string => StyleInfo.render(`ℹ ${msg}`);
export const renderHint = (msg: string): string => StyleDim.render(`  ${msg}`);
export const renderCmd = (cmd: string): string => StyleInfo.render(cmd);
export const renderDim = (msg: string): string => StyleDim.render(msg);
export const renderKeyValue = (key: string, value: string): string =>
  `${StyleDim.render(`${key}:`)} ${value}`;
export const renderField = (key: string, value: string): string =>
  `  ${StyleDim.render(`${key}:`)} ${value}`;
export const renderSectionHeader = (title: string): string => StyleBold.render(title);
export const renderStatusBadge = (status: string): string => statusStyle(status).render(status);
export const renderPriorityBadge = (p: string): string => priorityStyle(p).render(p);
export const renderSeparator = (width: number): string => StyleDim.render("─".repeat(width));
export const renderCount = (label: string, count: number): string =>
  `${StyleBold.render(label)} ${StyleDim.render(`(${count})`)}`;
