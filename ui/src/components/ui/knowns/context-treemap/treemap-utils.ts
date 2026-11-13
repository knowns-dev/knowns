import { isReserve, segTokens, type ContextKind, type ContextSegment } from "../context-window/context-utils";

export { segTokens };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Squarified treemap (Bruls, Huizing, van Wijk): fills `rect` with one rectangle per value, area in
 * proportion, rows chosen to keep each rectangle close to square. Items keep the order given, so a
 * layout stays put when sizes change a little (sort first if you want the squarest result).
 * Zero and negative values get an empty rect at the corner.
 */
export function squarify(values: number[], rect: Rect): Rect[] {
  const out: Rect[] = values.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }));
  const live = values.map((v, i) => ({ i, v: Math.max(0, v) })).filter((d) => d.v > 0);
  const total = live.reduce((n, d) => n + d.v, 0);
  if (!total || rect.w <= 0 || rect.h <= 0) return out;
  const scale = (rect.w * rect.h) / total;
  const items = live.map((d) => ({ i: d.i, a: d.v * scale }));
  let r = { ...rect };

  // The worst aspect ratio in a row laid along a side of length `side`.
  const worst = (row: number[], side: number) => {
    const s = row.reduce((n, a) => n + a, 0);
    const max = Math.max(...row);
    const min = Math.min(...row);
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };

  let k = 0;
  while (k < items.length) {
    const side = Math.min(r.w, r.h);
    const row = [items[k].a];
    let j = k + 1;
    while (j < items.length && worst([...row, items[j].a], side) <= worst(row, side)) row.push(items[j++].a);
    const sum = row.reduce((n, a) => n + a, 0);
    if (r.w >= r.h) {
      // A column on the left.
      const cw = j === items.length ? r.w : sum / r.h;
      let y = r.y;
      for (let n = k; n < j; n++) {
        const h = n === j - 1 ? r.y + r.h - y : items[n].a / cw;
        out[items[n].i] = { x: r.x, y, w: cw, h };
        y += h;
      }
      r = { x: r.x + cw, y: r.y, w: r.w - cw, h: r.h };
    } else {
      // A row on top.
      const rh = j === items.length ? r.h : sum / r.w;
      let x = r.x;
      for (let n = k; n < j; n++) {
        const w = n === j - 1 ? r.x + r.w - x : items[n].a / rh;
        out[items[n].i] = { x, y: r.y, w, h: rh };
        x += w;
      }
      r = { x: r.x, y: r.y + rh, w: r.w, h: r.h - rh };
    }
    k = j;
  }
  return out;
}

export type TileKind = ContextKind | "free" | "summary";

export interface Tile {
  /** Unique on the map: the segment id, or "segment/part" for a part. */
  key: string;
  segmentId: string;
  /** The segment's label ("Files"), for parts. */
  segmentLabel: string;
  partId?: string;
  label: string;
  tokens: number;
  kind: TileKind;
  reserve: boolean;
  detail?: string;
  /** Ids this tile replaced (compaction summary). */
  summaryOf?: string[];
  /** For an "n more" tile, or a segment drawn whole: the part or segment ids inside it. */
  members?: string[];
  rect: Rect;
  /** The segment's own rect (group), for the group label. */
  group: Rect;
}

export const FREE_ID = "__free";
export const MORE_ID = "__more";

/** Room for a label: at least `w` x `h` px (a name of about 9 characters, not a 3-letter crop). */
export const fits = (r: Rect, w = 64, h = 34) => r.w >= w && r.h >= h;

type More<T> = { more: T[]; tokens: number };
const isMore = <T,>(x: T | More<T>): x is More<T> => typeof x === "object" && x !== null && "more" in x;

/**
 * Lays `items` out in `rect`, and folds every item whose tile would be too small for a label into one
 * "n more" item at the end (never a silent sliver). A lone small item takes the next smallest along, so
 * "n more" always has n >= 2. `keep` items are never folded. Returns null when everything would fold.
 */
function packLabelled<T extends { tokens: number }>(items: T[], rect: Rect, pad: number, keep: (t: T) => boolean = () => false): { items: (T | More<T>)[]; rects: Rect[] } | null {
  // Largest first keeps every tile near square, so small ones don't end up as slivers along an edge.
  const bySize = (a: T | More<T>, b: T | More<T>) => b.tokens - a.tokens;
  let list: (T | More<T>)[] = [...items].sort(bySize);
  const place = () =>
    squarify(
      list.map((x) => x.tokens),
      { x: rect.x - pad, y: rect.y - pad, w: rect.w + 2 * pad, h: rect.h + 2 * pad },
    ).map((r) => inset(r, pad));
  // Each round folds at least one more item, so this ends within items.length rounds.
  for (let round = 0; round <= items.length; round++) {
    const rects = place();
    const foldable = (x: T | More<T>) => isMore(x) || !keep(x);
    const small = list.map((x, i) => i).filter((i) => !fits(rects[i]) && foldable(list[i]));
    if (!small.length) return { items: list, rects };
    // One "n more" per level: a new fold always absorbs the existing one.
    let pick = new Set([...small, ...list.map((x, i) => i).filter((i) => isMore(list[i]))]);
    const members = () => [...pick].flatMap((i) => (isMore(list[i]) ? (list[i] as More<T>).more : [list[i] as T]));
    // Grow the fold when it would not change anything (only "n more" is small) or would hold one item.
    if (members().length < 2 || small.every((i) => isMore(list[i]))) {
      const next = list
        .map((x, i) => i)
        .filter((i) => !pick.has(i) && foldable(list[i]))
        .sort((a, b) => list[a].tokens - list[b].tokens)[0];
      if (next === undefined) return { items: list, rects };
      pick.add(next);
    }
    if (pick.size >= list.length) return null;
    const folded = members().sort((a, b) => b.tokens - a.tokens);
    list = [...list.filter((_, i) => !pick.has(i)), { more: folded, tokens: folded.reduce((n, t) => n + t.tokens, 0) }].sort(bySize);
    pick = new Set();
  }
  return { items: list, rects: place() };
}

/**
 * Two levels: segments (free room included) share the area by tokens, then each segment's parts share
 * its rect, both largest first so tiles stay near square and the map reads big to small. Tiles too small for a label fold into an "n more" tile; a segment
 * whose parts would all fold is one tile. The whole map spans `span` tokens (the limit, or more when over).
 * `gap` is the px between groups and `inner` between parts; rects are already inset by them.
 */
export function layoutTiles(segments: ContextSegment[], span: number, size: { w: number; h: number }, opts: { gap?: number; inner?: number; freeLabel?: string; moreLabel?: (first: string, rest: number) => string } = {}): Tile[] {
  const { gap = 7, inner = 2, freeLabel = "Free", moreLabel = (first, rest) => `${first} + ${rest} more` } = opts;
  const used = segments.filter((s) => segTokens(s) > 0).sort((a, b) => segTokens(b) - segTokens(a));
  const total = used.reduce((n, s) => n + segTokens(s), 0);
  const free = Math.max(0, span - total);
  type G = { seg: ContextSegment | null; tokens: number };
  const groups: G[] = [...used.map((s) => ({ seg: s, tokens: segTokens(s) })), ...(free > 0 ? [{ seg: null, tokens: free }] : [])];
  // The outer edge needs no gap: the area grows by half a gap all round and every rect is inset by half.
  const g = gap / 2;
  const box = { x: 0, y: 0, w: size.w, h: size.h };
  let top = packLabelled(groups, box, g, (x) => !x.seg);
  // Free room too small to name leaves the map (the header still says how full it is): no unlabelled tile.
  const freeAt = top?.items.findIndex((x) => !isMore(x) && !x.seg) ?? -1;
  if (top && freeAt >= 0 && !fits(top.rects[freeAt])) {
    groups.pop();
    top = packLabelled(groups, box, g, () => false);
  }
  const placed = top ?? { items: groups, rects: squarify(groups.map((x) => x.tokens), { x: -g, y: -g, w: size.w + gap, h: size.h + gap }).map((r) => inset(r, g)) };
  const tiles: Tile[] = [];
  placed.items.forEach((item, i) => {
    const group = placed.rects[i];
    if (isMore(item)) {
      const segs = item.more.map((x) => x.seg!).filter(Boolean);
      const summaryOf = segs.flatMap((s) => [...(s.summaryOf ?? []), ...(s.parts ?? []).flatMap((p) => p.summaryOf ?? [])]);
      // Named after its largest member: "System prompt + 1 more".
      const name = moreLabel(segs[0]?.label ?? "", segs.length - 1);
      tiles.push({ key: MORE_ID, segmentId: MORE_ID, segmentLabel: name, label: name, tokens: item.tokens, kind: summaryOf.length ? "summary" : "other", reserve: false, detail: segs.map((s) => s.label).join(", "), members: segs.flatMap((s) => [s.id, ...(s.parts ?? []).map((p) => p.id)]), summaryOf: summaryOf.length ? summaryOf : undefined, rect: group, group });
      return;
    }
    const { seg, tokens } = item;
    if (!seg) {
      tiles.push({ key: FREE_ID, segmentId: FREE_ID, segmentLabel: freeLabel, label: freeLabel, tokens, kind: "free", reserve: false, rect: group, group });
      return;
    }
    const kind: TileKind = seg.summaryOf?.length ? "summary" : (seg.kind ?? "other");
    const parts = seg.parts?.filter((p) => p.tokens > 0) ?? [];
    const whole = (): Tile => ({
      key: seg.id,
      segmentId: seg.id,
      segmentLabel: seg.label,
      label: seg.label,
      tokens,
      kind,
      reserve: isReserve(seg),
      detail: seg.detail ?? (parts.length ? parts.map((p) => p.label).join(", ") : undefined),
      summaryOf: seg.summaryOf,
      members: parts.length ? parts.map((p) => p.id) : undefined,
      rect: group,
      group,
    });
    const sub = parts.length ? packLabelled(parts, group, inner / 2) : null;
    if (!sub) {
      tiles.push(whole());
      return;
    }
    sub.items.forEach((p, j) => {
      if (isMore(p)) {
        // A folded summary still takes the compaction: the tile inherits what it replaced, and says so.
        const summary = p.more.find((x) => x.summaryOf?.length);
        tiles.push({
          key: `${seg.id}/${MORE_ID}`,
          segmentId: seg.id,
          segmentLabel: seg.label,
          label: moreLabel((summary ?? p.more[0]).label, p.more.length - 1),
          tokens: p.tokens,
          kind: summary ? "summary" : kind,
          summaryOf: summary ? p.more.flatMap((x) => x.summaryOf ?? []) : undefined,
          reserve: isReserve(seg),
          detail: p.more.map((x) => x.label).join(", "),
          members: p.more.map((x) => x.id),
          rect: sub.rects[j],
          group,
        });
      } else
        tiles.push({
          key: `${seg.id}/${p.id}`,
          segmentId: seg.id,
          segmentLabel: seg.label,
          partId: p.id,
          label: p.label,
          tokens: p.tokens,
          kind: p.summaryOf?.length ? "summary" : kind,
          reserve: isReserve(seg),
          detail: p.detail,
          summaryOf: p.summaryOf ?? seg.summaryOf,
          rect: sub.rects[j],
          group,
        });
    });
  });
  return tiles;
}

function inset(r: Rect, d: number): Rect {
  return { x: r.x + d, y: r.y + d, w: Math.max(0, r.w - 2 * d), h: Math.max(0, r.h - 2 * d) };
}

/**
 * Where each tile that left the map went: a tile whose key, part id or segment id is listed in a new
 * tile's `summaryOf` flies into that tile (a compaction). Others just fade. Keys of leaving tiles -> target key.
 */
export function compactionTargets(prev: Tile[], next: Tile[]): Map<string, string | null> {
  const nextKeys = new Set(next.map((t) => t.key));
  const out = new Map<string, string | null>();
  for (const t of prev) {
    if (nextKeys.has(t.key) || t.kind === "free") continue;
    const ids = [t.key, t.partId, t.segmentId, ...(t.members ?? [])];
    const target = next.find((n) => n.summaryOf?.some((id) => ids.includes(id)));
    out.set(t.key, target?.key ?? null);
  }
  return out;
}
