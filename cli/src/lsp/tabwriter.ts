// Minimal text/tabwriter (minwidth 0, padchar ' ') for tab-terminated cells; the text after the last
// tab of a line is not part of any column. Widths count runes (ANSI escapes included, like Go).
const runeLen = (s: string): number => [...s].length;

export function tabwrite(lines: string[], padding = 2): string {
  const rows = lines.map((l) => l.split("\t"));
  const widths: number[][] = rows.map(() => []);
  const maxCols = Math.max(0, ...rows.map((r) => r.length - 1));
  for (let c = 0; c < maxCols; c++) {
    let i = 0;
    while (i < rows.length) {
      if ((rows[i] as string[]).length - 1 > c) {
        let j = i;
        let w = 0;
        while (j < rows.length && (rows[j] as string[]).length - 1 > c) {
          w = Math.max(w, runeLen((rows[j] as string[])[c] as string));
          j++;
        }
        for (let k = i; k < j; k++) (widths[k] as number[])[c] = w + padding;
        i = j;
      } else {
        i++;
      }
    }
  }
  return rows
    .map((cells, r) => {
      let out = "";
      for (let c = 0; c < cells.length - 1; c++) {
        const cell = cells[c] as string;
        out += cell + " ".repeat(((widths[r] as number[])[c] as number) - runeLen(cell));
      }
      return `${out}${cells[cells.length - 1]}\n`;
    })
    .join("");
}
