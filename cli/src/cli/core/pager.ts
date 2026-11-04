/** Output helpers and --page pagination (pager.go). The interactive pager no longer exists. */
import type { Command } from "./command.ts";

/** Reports whether stdout is a terminal. */
export function isTTY(): boolean {
  return process.stdout.isTTY === true;
}

/**
 * Writes rendered content to stdout. Nothing branches on the terminal: a person and a pipe get
 * the same bytes.
 */
export function printContent(cmd: Command, content: string): void {
  cmd.stdout(content);
}

/** Default number of lines per page for --page pagination. */
export const DEFAULT_PAGE_SIZE = 50;

/** Default number of items in plain list mode when paging is requested without a size. */
export const DEFAULT_PLAIN_ITEM_LIMIT = 20;

/** Reads --page and --page-size from the root persistent flags, then the command's own. */
export function getPageOpts(cmd: Command): { page: number; pageSize: number } {
  let pageSize = DEFAULT_PAGE_SIZE;
  const intFlag = (name: string): number => {
    const root = cmd.root().persistentFlags().lookup(name);
    const rv = root?.value.type === "int" ? (root.value.get() as number) : 0;
    if (rv > 0) return rv;
    const local = cmd.flags().lookup(name);
    return local?.value.type === "int" ? (local.value.get() as number) : 0;
  };
  const page = intFlag("page");
  const ps = intFlag("page-size");
  if (ps > 0) pageSize = ps;
  return { page, pageSize };
}

/**
 * Prints content with optional --page N pagination (for plain/AI output). Without --page it
 * prints everything; with it, one page and a PAGE footer telling the reader how to fetch more.
 */
export function printPaged(cmd: Command, content: string): void {
  const { page, pageSize } = getPageOpts(cmd);
  if (page <= 0) {
    cmd.stdout(content);
    return;
  }
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const totalLines = lines.length;
  const totalPages = Math.max(1, Math.floor((totalLines + pageSize - 1) / pageSize));

  if (page > totalPages) {
    cmd.stdout(`PAGE: ${page}/${totalPages} (no more content)\n`);
    return;
  }
  const start = (page - 1) * pageSize;
  const end = Math.min(start + pageSize, totalLines);
  let out = "";
  for (const line of lines.slice(start, end)) out += `${line}\n`;
  out += `\nPAGE: ${page}/${totalPages} (lines ${start + 1}-${end} of ${totalLines}, page-size ${pageSize})\n`;
  cmd.stdout(out);
}

/**
 * Whether the caller explicitly asked for a page of a plain listing, via --page or --page-size.
 * Plain listings page only when asked, never silently.
 */
export function plainPageRequested(cmd: Command): boolean {
  for (const name of ["page", "page-size"]) {
    if (cmd.root().persistentFlags().lookup(name)?.changed) return true;
    if (cmd.flags().lookup(name)?.changed) return true;
  }
  return false;
}
