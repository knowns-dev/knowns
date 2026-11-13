// Port of internal/cli/code_extract.go: symbol extraction through the LSP manager.
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { buildCodeSummaries, type CodeSummary } from "./code-search.ts";
import type { Ctx } from "./context.ts";
import type { Manager } from "./manager.ts";
import type { DocumentSymbol } from "./types.ts";

export async function extractFileLSP(
  ctx: Ctx,
  mgr: Manager,
  root: string,
  absPath: string,
): Promise<CodeSummary[]> {
  let symbols: DocumentSymbol[] = [];
  try {
    await mgr.withSession(ctx, absPath, async (session) => {
      symbols = await session.documentSymbols(ctx, absPath);
    });
  } catch {
    return [];
  }
  if (symbols.length === 0) return [];
  let data: string;
  try {
    data = readFileSync(absPath, "utf8");
  } catch {
    return [];
  }
  const rel = relative(root, absPath).split(sep).join("/");
  return buildCodeSummaries(rel, symbols, data);
}

const skipDirs = new Set([".", "node_modules", "vendor", "dist", "build", ".git"]);
const sourceExts = new Set([
  ".go",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".rs",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".kts",
]);

export function isSourceExt(ext: string): boolean {
  return sourceExts.has(ext);
}

/** findSourceFiles: lexical walk like filepath.WalkDir, capped at 200 files. */
export function findSourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, isRoot: boolean): void => {
    if (files.length >= 200) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (files.length >= 200) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(full, false);
        continue;
      }
      if (isSourceExt(extname(full).toLowerCase())) files.push(full);
    }
    void isRoot;
  };
  walk(root, true);
  return files;
}
