export type LineType = "context" | "add" | "del";

export interface DiffLine {
  type: LineType;
  text: string;
  /** 1-based line numbers in the old / new file (absent on the side the line isn't on). */
  oldNo?: number;
  newNo?: number;
  /** Changed character ranges [start, end) within `text` (word-level), for paired edits. */
  marks?: [number, number][];
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  /** Optional heading after the @@ (a function name in git patches). */
  header?: string;
}

type Op = { type: LineType; a?: number; b?: number };

/**
 * Myers' O(ND) diff of two sequences: the shortest edit script as equal / delete / insert ops in order.
 * Lines are compared with ===. Above `limit` total edits it gives up and returns delete-all + insert-all.
 */
export function diffSeq<T>(a: T[], b: T[], limit = 4000): Op[] {
  // Trim the common prefix and suffix first (cheap, and most real edits are local).
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const head: Op[] = Array.from({ length: pre }, (_, i) => ({ type: "context", a: i, b: i }));
  const tail: Op[] = Array.from({ length: suf }, (_, i) => ({ type: "context", a: a.length - suf + i, b: b.length - suf + i }));
  const n = A.length;
  const m = B.length;
  const mid: Op[] = [];
  const max = n + m;
  if (max > 0) {
    const off = max;
    const v = new Int32Array(2 * max + 2);
    const trace: Int32Array[] = [];
    let found = -1;
    for (let d = 0; d <= Math.min(max, limit); d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && A[x] === B[y]) {
          x++;
          y++;
        }
        v[off + k] = x;
        if (x >= n && y >= m) {
          found = d;
          break;
        }
      }
      if (found >= 0) break;
    }
    if (found < 0) {
      for (let i = 0; i < n; i++) mid.push({ type: "del", a: pre + i });
      for (let j = 0; j < m; j++) mid.push({ type: "add", b: pre + j });
    } else {
      // Walk the trace back from (n, m).
      let x = n;
      let y = m;
      const rev: Op[] = [];
      for (let d = found; d > 0; d--) {
        const vd = trace[d];
        const k = x - y;
        const prevK = k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1]) ? k + 1 : k - 1;
        const prevX = vd[off + prevK];
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) rev.push({ type: "context", a: pre + --x, b: pre + --y });
        if (x === prevX) rev.push({ type: "add", b: pre + --y });
        else rev.push({ type: "del", a: pre + --x });
      }
      while (x > 0 && y > 0) rev.push({ type: "context", a: pre + --x, b: pre + --y });
      mid.push(...rev.reverse());
    }
  }
  return [...head, ...mid, ...tail];
}

export const splitLines = (s: string) => (s === "" ? [] : s.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

/** Every line of the two texts, in order, with its type and line numbers. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  return diffSeq(a, b).map((op) =>
    op.type === "context"
      ? { type: "context", text: a[op.a!], oldNo: op.a! + 1, newNo: op.b! + 1 }
      : op.type === "del"
        ? { type: "del", text: a[op.a!], oldNo: op.a! + 1 }
        : { type: "add", text: b[op.b!], newNo: op.b! + 1 },
  );
}

/** Group changed lines into hunks with `context` unchanged lines around them (nearby hunks merge). */
export function toHunks(lines: DiffLine[], context = 3): Hunk[] {
  const changed = lines.map((l, i) => (l.type === "context" ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return [];
  const ranges: [number, number][] = [];
  for (const i of changed) {
    const lo = Math.max(0, i - context);
    const hi = Math.min(lines.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else ranges.push([lo, hi]);
  }
  return ranges.map(([lo, hi]) => {
    const ls = lines.slice(lo, hi + 1);
    const firstOld = ls.find((l) => l.oldNo !== undefined)?.oldNo ?? (lines.slice(0, lo).reverse().find((l) => l.oldNo !== undefined)?.oldNo ?? 0) + 1;
    const firstNew = ls.find((l) => l.newNo !== undefined)?.newNo ?? (lines.slice(0, lo).reverse().find((l) => l.newNo !== undefined)?.newNo ?? 0) + 1;
    return {
      oldStart: firstOld,
      oldLines: ls.filter((l) => l.type !== "add").length,
      newStart: firstNew,
      newLines: ls.filter((l) => l.type !== "del").length,
      lines: withWordMarks(ls),
    };
  });
}

const TOKEN = /\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g;
const tokens = (s: string) => s.match(TOKEN) ?? [];

/**
 * Word-level marks for one edited line: the character ranges that differ between `oldText` and `newText`.
 * Null when the lines share too little to be called the same line edited (then the whole line is the change).
 */
export function wordMarks(oldText: string, newText: string): { old: [number, number][]; new: [number, number][] } | null {
  const a = tokens(oldText);
  const b = tokens(newText);
  const ops = diffSeq(a, b, 400);
  const same = ops.filter((o) => o.type === "context").reduce((n, o) => n + a[o.a!].trim().length, 0);
  const total = Math.max(1, Math.max(oldText.replace(/\s/g, "").length, newText.replace(/\s/g, "").length));
  if (same / total < 0.4) return null;
  const pos = (ts: string[]) => {
    const p = [0];
    for (const t of ts) p.push(p[p.length - 1] + t.length);
    return p;
  };
  const pa = pos(a);
  const pb = pos(b);
  const merge = (list: [number, number][]) =>
    list.reduce<[number, number][]>((acc, r) => {
      const last = acc[acc.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else acc.push([...r]);
      return acc;
    }, []);
  return {
    old: merge(ops.filter((o) => o.type === "del").map((o) => [pa[o.a!], pa[o.a! + 1]])),
    new: merge(ops.filter((o) => o.type === "add").map((o) => [pb[o.b!], pb[o.b! + 1]])),
  };
}

/** Pair each run of deleted lines with the added lines right after it, and mark the words that changed. */
export function withWordMarks(lines: DiffLine[]): DiffLine[] {
  const out = lines.map((l) => ({ ...l }));
  for (let i = 0; i < out.length; ) {
    if (out[i].type !== "del") {
      i++;
      continue;
    }
    let d = i;
    while (d < out.length && out[d].type === "del") d++;
    let e = d;
    while (e < out.length && out[e].type === "add") e++;
    const pairs = Math.min(d - i, e - d);
    for (let k = 0; k < pairs; k++) {
      const m = wordMarks(out[i + k].text, out[d + k].text);
      if (m) {
        out[i + k].marks = m.old;
        out[d + k].marks = m.new;
      }
    }
    i = e;
  }
  return out;
}

/** +added / −removed lines. */
export function countChanges(lines: DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter((l) => l.type === "add").length, removed: lines.filter((l) => l.type === "del").length };
}

/** Side by side: unchanged lines on both sides; deletions on the left, additions on the right, paired in order. */
export function splitRows(lines: DiffLine[]): { left?: DiffLine; right?: DiffLine }[] {
  const rows: { left?: DiffLine; right?: DiffLine }[] = [];
  for (let i = 0; i < lines.length; ) {
    const l = lines[i];
    if (l.type === "context") {
      rows.push({ left: l, right: l });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].type === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].type === "add") adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k], right: adds[k] });
  }
  return rows;
}

/** Parse the hunks of one file from a unified diff ("@@ -12,7 +12,9 @@ heading" blocks); file headers are skipped. */
export function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let o = 0;
  let n = 0;
  // The newline that ends the patch doesn't start another (blank) line.
  for (const raw of patch.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n")) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(raw);
    if (h) {
      cur = { oldStart: +h[1], oldLines: h[2] === undefined ? 1 : +h[2], newStart: +h[3], newLines: h[4] === undefined ? 1 : +h[4], lines: [], header: h[5] || undefined };
      hunks.push(cur);
      o = cur.oldStart;
      n = cur.newStart;
      continue;
    }
    if (!cur || raw.startsWith("\\")) continue;
    const c = raw[0];
    if (c === "+") cur.lines.push({ type: "add", text: raw.slice(1), newNo: n++ });
    else if (c === "-") cur.lines.push({ type: "del", text: raw.slice(1), oldNo: o++ });
    else if (c === " " || raw === "") cur.lines.push({ type: "context", text: raw.slice(1), oldNo: o++, newNo: n++ });
  }
  return hunks.map((h) => ({ ...h, lines: withWordMarks(h.lines) }));
}

/** Split a multi-file git patch into files ("diff --git a/x b/y" blocks): paths, status and the patch text. */
export function splitPatchFiles(patch: string): { path: string; oldPath?: string; status: FileStatus; patch: string }[] {
  const blocks = patch.replace(/\r\n/g, "\n").split(/^(?=diff --git )/m).filter((b) => b.startsWith("diff --git "));
  return blocks.map((b) => {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(b);
    const oldPath = m?.[1];
    const path = m?.[2] ?? "";
    const status: FileStatus = /^new file mode/m.test(b) ? "added" : /^deleted file mode/m.test(b) ? "deleted" : oldPath && oldPath !== path ? "renamed" : "modified";
    return { path, oldPath: status === "renamed" ? oldPath : undefined, status, patch: b };
  });
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

/** Five blocks showing the share of additions vs deletions (like a commit summary): [adds, dels, empty]. */
export function changeBlocks(added: number, removed: number, blocks = 5): [number, number, number] {
  const total = added + removed;
  if (!total) return [0, 0, blocks];
  const filled = Math.min(blocks, Math.max(1, Math.round(Math.log2(total + 1) * 0.9)));
  let adds = Math.round((added / total) * filled);
  if (added && !adds) adds = 1;
  if (removed && adds === filled && filled > 1) adds = filled - 1;
  return [adds, filled - adds, blocks - filled];
}

/** Hunks of a file, from before / after texts or a patch. */
export function hunksOf(src: { before?: string; after?: string; patch?: string }, context = 3): Hunk[] {
  if (src.patch !== undefined) return parsePatch(src.patch);
  return toHunks(diffLines(src.before ?? "", src.after ?? ""), context);
}
