// Port of internal/lsp/dart.go.
import { readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

export { DartLanguageID } from "./types.ts";

export interface DartProjectSelection {
  path: string;
  kind: string;
}

export function fileExists(path: string): boolean {
  try {
    return !statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

const DART_SKIP_DIRS = new Set([
  ".git",
  ".knowns",
  ".dart_tool",
  "build",
  "node_modules",
  "vendor",
]);

export function discoverDartProject(root: string): DartProjectSelection {
  if (root === "") return { path: "", kind: "" };
  const rootAbs = resolve(root);
  let firstDart = "";
  let selected: DartProjectSelection = { path: "", kind: "" };

  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // filepath.WalkDir visits entries in lexical order.
    entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (DART_SKIP_DIRS.has(entry.name)) continue;
        walk(path);
        continue;
      }
      if (extname(path).toLowerCase() !== ".dart") continue;
      if (firstDart === "") firstDart = path;
      const candidate = discoverDartProjectForFile(rootAbs, path);
      if (candidate.kind === "pubspec" && selected.kind !== "pubspec") selected = candidate;
      if (candidate.kind === "analysis_options" && selected.path === "") selected = candidate;
    }
  };
  walk(rootAbs);

  if (selected.path !== "") return selected;
  if (firstDart === "") return { path: "", kind: "" };
  return { path: rootAbs, kind: "root" };
}

export function discoverDartProjectForFile(rootAbs: string, path: string): DartProjectSelection {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    if (fileExists(join(dir, "pubspec.yaml"))) return { path: dir, kind: "pubspec" };
    if (fileExists(join(dir, "analysis_options.yaml")))
      return { path: dir, kind: "analysis_options" };
    if (samePath(dir, rootAbs) || dir === dirname(dir)) break;
  }
  return { path: "", kind: "" };
}

export function parseDartSDKVersion(output: string): string {
  let out = output.trim();
  if (out === "") return "";
  const prefix = "Dart SDK version:";
  if (out.startsWith(prefix)) out = out.slice(prefix.length).trim();
  const fields = out.split(/\s+/).filter((f) => f !== "");
  const first = fields[0];
  if (first === undefined) return "";
  return first.replace(/^,+|,+$/g, "");
}
