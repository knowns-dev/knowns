export interface FuzzyMatch {
  score: number;
  /** [start, end) ranges in the text that matched, merged. */
  ranges: [number, number][];
}

const isWordStart = (text: string, i: number) => i === 0 || /[\s\-_/.:]/.test(text[i - 1]) || (/[a-z]/.test(text[i - 1]) && /[A-Z]/.test(text[i]));

const merge = (idx: number[]): [number, number][] => {
  const out: [number, number][] = [];
  for (const i of idx) {
    const last = out[out.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else out.push([i, i + 1]);
  }
  return out;
};

/**
 * Case-insensitive fuzzy match: every query character in order. Higher is better. A contiguous hit beats a
 * scattered one, word starts and a prefix get a bonus, gaps cost a little. Spaces in the query are ignored
 * so "new pr" finds "New project". Returns null when it does not match.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { score: 0, ranges: [] };
  const t = text.toLowerCase();

  // Contiguous substring first: the best possible highlight.
  const at = t.indexOf(q);
  if (at !== -1) {
    const score = 100 + q.length * 10 + (at === 0 ? 40 : 0) + (isWordStart(text, at) ? 20 : 0) - at * 0.5 - (t.length - q.length) * 0.1;
    return { score, ranges: [[at, at + q.length]] };
  }

  // Greedy subsequence that prefers word starts: look ahead for a word-start occurrence of each char.
  const idx: number[] = [];
  let from = 0;
  for (const ch of q) {
    let pick = -1;
    for (let i = from; i < t.length; i++) {
      if (t[i] !== ch) continue;
      if (pick === -1) pick = i;
      if (isWordStart(text, i) || (idx.length && i === idx[idx.length - 1] + 1)) {
        pick = i;
        break;
      }
    }
    if (pick === -1) return null;
    idx.push(pick);
    from = pick + 1;
  }
  let score = 0;
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    score += 10;
    if (isWordStart(text, i)) score += 8;
    if (k > 0) {
      const gap = i - idx[k - 1] - 1;
      score += gap === 0 ? 6 : -Math.min(gap, 6);
    }
  }
  if (idx[0] === 0) score += 10;
  return { score, ranges: merge(idx) };
}

/** Split text into highlighted / plain parts for rendering. */
export function highlightParts(text: string, ranges: [number, number][]): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let pos = 0;
  for (const [a, b] of ranges) {
    if (a > pos) out.push({ text: text.slice(pos, a), hit: false });
    out.push({ text: text.slice(a, b), hit: true });
    pos = b;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out.filter((p) => p.text);
}

export interface Rankable {
  id: string;
  label: string;
  keywords?: string[];
  disabled?: boolean;
}

/**
 * Items that match, best first (ties keep the given order). The label is what gets highlighted; keywords
 * can make an item match but score a little lower and highlight nothing. Keywords match only as a
 * substring: a scattered subsequence in a long keyword ("Blocks / Illustrations" for "butt") is noise.
 */
export function rankItems<T extends Rankable>(items: T[], query: string): { item: T; ranges: [number, number][]; score: number }[] {
  if (!query.trim()) return items.map((item) => ({ item, ranges: [], score: 0 }));
  const out: { item: T; ranges: [number, number][]; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    const m = fuzzyMatch(query, item.label);
    let best = m ? { score: m.score, ranges: m.ranges } : null;
    const q = query.toLowerCase().replace(/\s+/g, "");
    for (const k of item.keywords ?? []) {
      if (!k.toLowerCase().replace(/\s+/g, "").includes(q)) continue;
      const km = fuzzyMatch(query, k);
      if (km && (!best || km.score - 15 > best.score)) best = { score: km.score - 15, ranges: m?.ranges ?? [] };
    }
    if (best) out.push({ item, ranges: best.ranges, score: best.score, i });
  });
  return out.sort((a, b) => b.score - a.score || a.i - b.i).map(({ item, ranges, score }) => ({ item, ranges, score }));
}

/** Group in first-seen order (or `order` first), keeping item order inside each group. */
export function groupBy<T extends { group?: string }>(items: T[], order: string[] = []): { group: string; items: T[] }[] {
  const map = new Map<string, T[]>();
  for (const g of order) map.set(g, []);
  for (const it of items) {
    const g = it.group ?? "";
    (map.get(g) ?? map.set(g, []).get(g)!).push(it);
  }
  return [...map].filter(([, xs]) => xs.length).map(([group, xs]) => ({ group, items: xs }));
}

/** Recently used ids: the newest first, no duplicates, at most `max`. */
export function pushRecent(recents: string[], id: string, max = 5): string[] {
  return [id, ...recents.filter((r) => r !== id)].slice(0, max);
}

/** Next active index among enabled rows (wraps). -1 when nothing is enabled. */
export function moveActive(disabled: boolean[], from: number, key: string): number | null {
  const n = disabled.length;
  if (!n) return key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End" ? -1 : null;
  const first = disabled.findIndex((d) => !d);
  if (first === -1) return -1;
  const last = n - 1 - [...disabled].reverse().findIndex((d) => !d);
  if (key === "Home") return first;
  if (key === "End") return last;
  const dir = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
  if (!dir) return null;
  let i = from;
  for (let step = 0; step < n; step++) {
    i = (i + dir + n) % n;
    if (!disabled[i]) return i;
  }
  return from;
}

/** Whether a keydown is the menu's hotkey: "mod+k" means ⌘K on macOS and Ctrl+K elsewhere. */
export function isHotkey(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, hotkey: string, mac: boolean): boolean {
  const parts = hotkey.toLowerCase().split("+");
  const key = parts.pop()!;
  const want = { mod: parts.includes("mod"), shift: parts.includes("shift"), alt: parts.includes("alt") };
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return e.key.toLowerCase() === key && mod === want.mod && e.shiftKey === want.shift && e.altKey === want.alt;
}

/** "mod+k" → ["⌘", "K"] on macOS, ["Ctrl", "K"] elsewhere. */
export function hotkeyLabel(hotkey: string, mac: boolean): string[] {
  return hotkey.split("+").map((p) => {
    const l = p.toLowerCase();
    if (l === "mod") return mac ? "⌘" : "Ctrl";
    if (l === "shift") return mac ? "⇧" : "Shift";
    if (l === "alt") return mac ? "⌥" : "Alt";
    return p.length === 1 ? p.toUpperCase() : p;
  });
}
