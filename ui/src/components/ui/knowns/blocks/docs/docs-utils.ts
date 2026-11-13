export interface TocItem {
  id: string;
  text: string;
  /** 2 for h2, 3 for h3. */
  depth: number;
}

export interface TocNode extends TocItem {
  children: TocNode[];
}

/** "Motion & accessibility" -> "motion-accessibility". */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Flat headings into a tree: each h3 sits under the h2 before it (a leading h3 becomes a top item). */
export function tocTree(items: TocItem[]): TocNode[] {
  const out: TocNode[] = [];
  for (const it of items) {
    const node: TocNode = { ...it, children: [] };
    const parent = out[out.length - 1];
    if (it.depth > 2 && parent && parent.depth < it.depth) parent.children.push(node);
    else out.push(node);
  }
  return out;
}

/**
 * The heading that is "current" for a scroll position: the last one whose top is above `offset`
 * (px from the viewport top), else the first. `tops` are viewport-relative, in document order.
 */
export function activeHeading(tops: { id: string; top: number }[], offset = 96): string | null {
  if (!tops.length) return null;
  let cur = tops[0].id;
  for (const t of tops) if (t.top - offset <= 1) cur = t.id;
  return cur;
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export const PACKAGE_MANAGERS: PackageManager[] = ["npm", "pnpm", "yarn", "bun"];

const RUNNER: Record<PackageManager, string> = { npm: "npx", pnpm: "pnpm dlx", yarn: "yarn dlx", bun: "bunx --bun" };
const ADD: Record<PackageManager, string> = { npm: "npm install", pnpm: "pnpm add", yarn: "yarn add", bun: "bun add" };

/** `npx shadcn@latest add <targets>` for each package manager. */
export function shadcnAdd(pm: PackageManager, targets: string[]): string {
  return `${RUNNER[pm]} shadcn@latest add ${targets.join(" ")}`;
}

/** `npm install <deps>` for each package manager; "" without deps. */
export function installDeps(pm: PackageManager, deps: string[]): string {
  return deps.length ? `${ADD[pm]} ${deps.join(" ")}` : "";
}

/** The shape of a shadcn registry item (what /r/<name>.json serves) that a manual install needs. */
export interface RegistryItemJson {
  name: string;
  dependencies?: string[];
  registryDependencies?: string[];
  files?: { path: string; target?: string; type?: string; content?: string }[];
}

export interface ManualFile {
  /** Where to put it in the user's project, e.g. "components/ui/knowns/badge.tsx". */
  target: string;
  code: string;
  lang: string;
}

export interface ManualPlan {
  dependencies: string[];
  /** Other registry items to add first (by name or URL). */
  registryDependencies: string[];
  files: ManualFile[];
}

const LANGS: Record<string, string> = { tsx: "tsx", ts: "ts", css: "css", json: "json", js: "ts", jsx: "tsx", mjs: "ts" };

/** Where a file lands without an explicit target: shadcn's defaults per file type. */
export function defaultTarget(path: string, type?: string): string {
  const base = path.replace(/^registry\/[^/]+\//, "").replace(/^ui\//, "");
  if (type === "registry:lib") return `lib/${base.replace(/^lib\//, "")}`;
  if (type === "registry:hook") return `hooks/${base.replace(/^hooks\//, "")}`;
  return `components/ui/${base.replace(/^components\/ui\//, "")}`;
}

/** The manual install steps for a registry item: npm deps, registry deps, then each file with its target. */
export function manualPlan(item: RegistryItemJson): ManualPlan {
  return {
    dependencies: [...new Set(item.dependencies ?? [])],
    registryDependencies: [...new Set(item.registryDependencies ?? [])],
    files: (item.files ?? [])
      .filter((f) => typeof f.content === "string")
      .map((f) => {
        const target = f.target || defaultTarget(f.path, f.type);
        const ext = target.split(".").pop() ?? "";
        return { target, code: f.content as string, lang: LANGS[ext] ?? "tsx" };
      }),
  };
}

export type PreviewViewport = "mobile" | "tablet" | "desktop";
export const VIEWPORT_WIDTH: Record<PreviewViewport, number | null> = { mobile: 390, tablet: 768, desktop: null };

/**
 * The scale that fits a frame of `width` px into `available` px, capped by the chosen zoom
 * (1 = 100%). Never upscales.
 */
export function fitScale(width: number, available: number, zoom = 1): number {
  if (width <= 0 || available <= 0) return zoom;
  return Math.min(zoom, available / width, 1);
}
