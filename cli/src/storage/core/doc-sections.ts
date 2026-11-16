// The one place that decides which lines of a markdown document are headings. Fenced code (``` and
// ~~~), HTML comments and (because a heading must start in column 0) indented code, blockquotes and
// list items never count. Every section walker (MCP docs, CLI doc, history, validate) goes through
// here so they cannot disagree.

/** mask[i] is true when line i is real markdown (not inside a fence or an HTML comment). */
export function proseMask(lines: readonly string[]): boolean[] {
  const mask: boolean[] = new Array(lines.length).fill(true);
  let fence: { ch: string; len: number } | undefined;
  let comment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).replace(/\r$/, "");
    if (fence) {
      mask[i] = false;
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (m && (m[1] as string)[0] === fence.ch && (m[1] as string).length >= fence.len) {
        fence = undefined;
      }
      continue;
    }
    if (comment) {
      mask[i] = false;
      if (line.includes("-->")) comment = false;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    // A backtick fence's info string cannot contain a backtick (that is inline code).
    if (open && !((open[1] as string)[0] === "`" && (open[2] as string).includes("`"))) {
      fence = { ch: (open[1] as string)[0] as string, len: (open[1] as string).length };
      mask[i] = false;
      continue;
    }
    const c = line.lastIndexOf("<!--");
    if (c >= 0 && !line.slice(c).includes("-->")) {
      comment = true;
    }
  }
  return mask;
}

/** Indexes of the heading lines (start with # in column 0, outside fences and comments). */
export function headingLineIndexes(lines: readonly string[]): number[] {
  const mask = proseMask(lines);
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (mask[i] && (lines[i] as string).startsWith("#")) out.push(i);
  }
  return out;
}

/** A reference that is only an integer addresses the nth heading; anything else is a title. */
export function bareIndex(ref: string): number | undefined {
  const m = /^\s*(\d+)\s*$/.exec(ref);
  return m ? Number(m[1]) : undefined;
}
