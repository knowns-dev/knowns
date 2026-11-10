import type { ReactNode } from "react";

export interface SidebarNode {
  /** Unique within the tree. Used for the open state, keys and keyboard focus. */
  id: string;
  label: string;
  /** A link row. Without it a parent row only folds, and a leaf row is a button (onSelect). */
  href?: string;
  /** 16px glyph. In the icon rail it is the whole row. */
  icon?: ReactNode;
  /** A small pill after the label, e.g. "Beta". */
  badge?: ReactNode;
  /** A muted number on the right, e.g. unread items. */
  count?: number;
  /** A trailing mark, e.g. a star or a dot. */
  mark?: ReactNode;
  children?: SidebarNode[];
  /** Open on first render when nothing is remembered. */
  defaultOpen?: boolean;
  disabled?: boolean;
}

/** The ids from the root down to `id` (inclusive). Empty when `id` is not in the tree. */
export function pathTo(nodes: SidebarNode[], id: string | undefined): string[] {
  if (!id) return [];
  for (const n of nodes) {
    if (n.id === id) return [n.id];
    if (n.children) {
      const p = pathTo(n.children, id);
      if (p.length) return [n.id, ...p];
    }
  }
  return [];
}

/** The ancestors of `id` (its path without itself): the branches to open so the row shows. */
export const ancestorsOf = (nodes: SidebarNode[], id: string | undefined) => pathTo(nodes, id).slice(0, -1);

/**
 * Keep the leaves that pass `keep`, and the parents that still have a child left. A parent is never
 * kept for itself, so a filter can empty a whole group.
 */
export function filterTree(nodes: SidebarNode[], keep: (n: SidebarNode) => boolean): SidebarNode[] {
  const out: SidebarNode[] = [];
  for (const n of nodes) {
    if (n.children) {
      const children = filterTree(n.children, keep);
      if (children.length) out.push({ ...n, children });
    } else if (keep(n)) out.push(n);
  }
  return out;
}

/** Leaf rows under a node list. */
export function countLeaves(nodes: SidebarNode[]): number {
  return nodes.reduce((s, n) => s + (n.children ? countLeaves(n.children) : 1), 0);
}

/** The node with this id, or undefined. */
export function findNode(nodes: SidebarNode[], id: string): SidebarNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = n.children && findNode(n.children, id);
    if (hit) return hit;
  }
  return undefined;
}

export interface VisibleRow {
  id: string;
  depth: number;
  parent?: string;
  branch: boolean;
  disabled?: boolean;
}

/** The rows a reader can see, top to bottom: children show only under open parents. */
export function visibleRows(nodes: SidebarNode[], open: ReadonlySet<string>, depth = 0, parent?: string): VisibleRow[] {
  const out: VisibleRow[] = [];
  for (const n of nodes) {
    out.push({ id: n.id, depth, parent, branch: Boolean(n.children?.length), disabled: n.disabled });
    if (n.children?.length && open.has(n.id)) out.push(...visibleRows(n.children, open, depth + 1, n.id));
  }
  return out;
}

export type TreeMove = { focus: string } | { open: string } | { close: string } | null;

/**
 * What a key does in the tree (the WAI tree view pattern): up and down move between visible rows,
 * Home and End jump, right opens a closed branch or steps into an open one, left closes an open branch
 * or steps out to the parent. Disabled rows are skipped.
 */
export function treeKey(rows: VisibleRow[], open: ReadonlySet<string>, from: string, key: string): TreeMove {
  const enabled = rows.filter((r) => !r.disabled);
  const i = rows.findIndex((r) => r.id === from);
  const row = rows[i];
  if (!row) return enabled[0] ? { focus: enabled[0].id } : null;
  const step = (dir: 1 | -1) => {
    for (let j = i + dir; j >= 0 && j < rows.length; j += dir) if (!rows[j].disabled) return { focus: rows[j].id };
    return null;
  };
  switch (key) {
    case "ArrowDown":
      return step(1);
    case "ArrowUp":
      return step(-1);
    case "Home":
      return enabled[0] && enabled[0].id !== from ? { focus: enabled[0].id } : null;
    case "End": {
      const last = enabled[enabled.length - 1];
      return last && last.id !== from ? { focus: last.id } : null;
    }
    case "ArrowRight":
      if (!row.branch) return null;
      return open.has(row.id) ? step(1) : { open: row.id };
    case "ArrowLeft":
      if (row.branch && open.has(row.id)) return { close: row.id };
      return row.parent ? { focus: row.parent } : null;
    default:
      return null;
  }
}

/** The initial open set: what was remembered, else every defaultOpen branch; plus the active row's ancestors. */
export function initialOpen(nodes: SidebarNode[], remembered: string[] | null, active?: string): Set<string> {
  const base = remembered ?? collect(nodes, (n) => Boolean(n.defaultOpen && n.children?.length));
  return new Set([...base, ...ancestorsOf(nodes, active)]);
}

function collect(nodes: SidebarNode[], pick: (n: SidebarNode) => boolean): string[] {
  return nodes.flatMap((n) => [...(pick(n) ? [n.id] : []), ...(n.children ? collect(n.children, pick) : [])]);
}

/** localStorage read that survives private mode and bad JSON. */
export function loadJSON<T>(key: string | undefined, fallback: T): T {
  if (!key || typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string | undefined, value: unknown) {
  if (!key || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or full */
  }
}

/** Cmd+B on macOS, Ctrl+B elsewhere; never while typing in a field (B is a letter). */
export function isToggleKey(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, mac: boolean, target?: EventTarget | null): boolean {
  if (e.key.toLowerCase() !== "b" || e.altKey || e.shiftKey) return false;
  if (!(mac ? e.metaKey : e.ctrlKey)) return false;
  const el = target as HTMLElement | null | undefined;
  return !(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? "")));
}

/** Letters for a workspace mark: one for a one-word name ("Northwind" gives "N", not "NO"), else the first two words' initials. */
export function workspaceInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words
    .slice(0, words.length > 1 ? 2 : 1)
    .map((w) => [...w][0])
    .join("")
    .toUpperCase();
}

/** The <html> attribute sidebarBootScript sets: the storage keys whose sidebar was left collapsed. */
export const BOOT_ATTR = "data-kn-sidebar-boot";

/**
 * A blocking script for <head> (beside the theme script): marks each remembered-collapsed key on <html> so the
 * server-rendered sidebar paints collapsed, with no flash and no transition. The provider clears the mark once its
 * state has taken over. Only for providers with a `storageKey`. Plain module (no "use client"), so a server
 * layout can call it.
 */
export function sidebarBootScript(keys: string[]): string {
  return `try{var h=document.documentElement,k=${JSON.stringify(keys)};for(var i=0;i<k.length;i++)if(localStorage.getItem(k[i]+":collapsed")==="true")h.setAttribute("${BOOT_ATTR}",((h.getAttribute("${BOOT_ATTR}")||"")+" "+k[i]).trim())}catch(e){}`;
}
