import { diffSeq } from "./diff-utils";

export type ProsePart = { kind: "same"; text: string } | { kind: "edit"; id: string; old: string; new: string };
export type ProseDecision = "accepted" | "rejected";

/** Words and the whitespace between them, as separate tokens. */
const tokens = (s: string) => s.match(/\s+|[^\s]+/g) ?? [];

/**
 * The suggestions that turn `before` into `after`, word by word. Neighbouring changes separated only by
 * spaces become one suggestion, so "the quick brown" → "a slow brown" reads as one replace, not two.
 */
export function proseParts(before: string, after: string): ProsePart[] {
  const a = tokens(before);
  const b = tokens(after);
  const ops = diffSeq(a, b, 2000);
  const parts: ProsePart[] = [];
  let id = 0;
  const pushSame = (t: string) => {
    const last = parts[parts.length - 1];
    if (last?.kind === "same") last.text += t;
    else parts.push({ kind: "same", text: t });
  };
  const edit = () => {
    const last = parts[parts.length - 1];
    if (last?.kind === "edit") return last;
    const e: ProsePart = { kind: "edit", id: `s${++id}`, old: "", new: "" };
    parts.push(e);
    return e;
  };
  for (const o of ops) {
    if (o.type === "context") pushSame(a[o.a!]);
    else if (o.type === "del") (edit() as Extract<ProsePart, { kind: "edit" }>).old += a[o.a!];
    else (edit() as Extract<ProsePart, { kind: "edit" }>).new += b[o.b!];
  }
  // Fold "edit, spaces, edit" into one edit.
  const out: ProsePart[] = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    const before2 = out[out.length - 2];
    if (p.kind === "edit" && prev?.kind === "same" && /^\s+$/.test(prev.text) && before2?.kind === "edit") {
      before2.old += prev.text + p.old;
      before2.new += prev.text + p.new;
      out.pop();
      continue;
    }
    out.push(p.kind === "edit" ? { ...p } : { ...p });
  }
  return out.map((p, i) => (p.kind === "edit" ? { ...p, id: `s${i}` } : p));
}

export const editsOf = (parts: ProsePart[]) => parts.filter((p): p is Extract<ProsePart, { kind: "edit" }> => p.kind === "edit");

/** The text with the decisions applied. Undecided suggestions keep the old words, or the new ones with `pending: "new"`. */
export function applyDecisions(parts: ProsePart[], decisions: Record<string, ProseDecision | undefined>, pending: "old" | "new" = "old"): string {
  return parts
    .map((p) => {
      if (p.kind === "same") return p.text;
      const d = decisions[p.id];
      return d === "accepted" || (!d && pending === "new") ? p.new : p.old;
    })
    .join("");
}

const q = (s: string) => `“${s.trim()}”`;

/** "Replace “available” with “ready”", "Delete “very”", "Insert “today”". */
export function describeEdit(e: { old: string; new: string }): string {
  if (!e.old.trim()) return `Insert ${q(e.new)}`;
  if (!e.new.trim()) return `Delete ${q(e.old)}`;
  return `Replace ${q(e.old)} with ${q(e.new)}`;
}

/** The next undecided suggestion after index `i` (wrapping), or -1 when none is left. */
export function nextPending(ids: string[], decisions: Record<string, ProseDecision | undefined>, i: number, dir: 1 | -1 = 1): number {
  const n = ids.length;
  for (let k = 1; k <= n; k++) {
    const j = (((i + dir * k) % n) + n) % n;
    if (!decisions[ids[j]]) return j;
  }
  return -1;
}
