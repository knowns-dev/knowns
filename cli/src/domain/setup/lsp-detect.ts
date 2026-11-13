// Language detection for `knowns init` (internal/lsp registry + detector as autoInstallLSPServers
// builds them): the builtin languages first, then every adapter registered by extension only.
// Registration refuses an extension owned by another language, exactly like Registry.Register, so
// e.g. the TypeScript adapter (.tsx is the builtin "typescriptreact") is skipped and the builtin
// entries stay. Only detection is ported; installing language servers is not.
import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";

interface Lang {
  id: string;
  exts: string[];
}

const BUILTIN: Lang[] = [
  { id: "go", exts: [".go"] },
  { id: "typescript", exts: [".ts"] },
  { id: "typescriptreact", exts: [".tsx"] },
  { id: "javascript", exts: [".js"] },
  { id: "javascriptreact", exts: [".jsx"] },
  { id: "python", exts: [".py"] },
  { id: "rust", exts: [".rs"] },
  { id: "dart", exts: [".dart"] },
];

/** adapters.All() in order: id and Extensions(). */
const ADAPTERS: Lang[] = [
  { id: "go", exts: [".go"] },
  { id: "typescript", exts: [".ts", ".tsx", ".js", ".jsx"] },
  { id: "python", exts: [".py"] },
  { id: "rust", exts: [".rs"] },
  { id: "c_cpp", exts: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx"] },
  { id: "java", exts: [".java"] },
  { id: "csharp", exts: [".cs"] },
  { id: "dart", exts: [".dart"] },
  { id: "swift", exts: [".swift"] },
  { id: "ruby", exts: [".rb", ".rake", ".gemspec"] },
  { id: "php", exts: [".php"] },
  { id: "scss", exts: [".scss", ".sass", ".css"] },
  { id: "markdown", exts: [".md", ".markdown"] },
  { id: "bash", exts: [".sh", ".bash"] },
  { id: "json", exts: [".json", ".jsonc"] },
  { id: "terraform", exts: [".tf", ".tfvars", ".tf.json", ".tfvars.json"] },
  { id: "yaml", exts: [".yaml", ".yml"] },
];

const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".knowns",
  ".svn",
  "build",
  "dist",
  "fixture",
  "fixtures",
  "gen",
  "generated",
  "node_modules",
  "out",
  "target",
  "test-data",
  "testdata",
  "third_party",
  "vendor",
  "vendored",
]);

/** The registry init builds: builtin languages, then adapters, with Register's conflict rule. */
function buildRegistry(): Lang[] {
  const languages: Lang[] = [];
  const byExt = new Map<string, Lang>();
  const register = (lang: Lang): void => {
    const exts = [...new Set(lang.exts.map((e) => e.trim().toLowerCase()).filter((e) => e !== ""))];
    if (lang.id === "" || exts.length === 0) return;
    for (const ext of exts) {
      const owner = byExt.get(ext);
      if (owner && owner.id !== lang.id) return;
    }
    for (const [ext, owner] of [...byExt]) if (owner.id === lang.id) byExt.delete(ext);
    const entry: Lang = { id: lang.id, exts };
    const at = languages.findIndex((l) => l.id === lang.id);
    if (at >= 0) languages[at] = entry;
    else languages.push(entry);
    for (const ext of exts) byExt.set(ext, entry);
  };
  for (const l of BUILTIN) register(l);
  for (const l of ADAPTERS) register(l);
  return languages;
}

/** The suffix matchers, ordered as the registry sorts them (longest pattern first). */
function sortedMatchers(languages: Lang[]): { pattern: string; id: string }[] {
  const all = languages.flatMap((l) => l.exts.map((pattern) => ({ pattern, id: l.id })));
  return all.sort((a, b) => {
    if (a.pattern.length !== b.pattern.length) return b.pattern.length - a.pattern.length;
    if (a.pattern !== b.pattern) return a.pattern < b.pattern ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function hasKnownsSegment(path: string): boolean {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .some((s) => s.toLowerCase() === ".knowns");
}

/** DetectedLanguages: the language ids with matching files under root, in registry order. */
export function detectLanguages(root: string): string[] {
  const languages = buildRegistry();
  const matchers = sortedMatchers(languages);
  const seen = new Set<string>();

  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name.trim().toLowerCase())) continue;
        walk(path);
        continue;
      }
      if (hasKnownsSegment(path)) continue;
      const lower = path.replaceAll("\\", "/").toLowerCase();
      const hit = matchers.find((m) => lower.endsWith(m.pattern));
      if (hit) seen.add(hit.id);
    }
  };
  walk(root);
  return languages.filter((l) => seen.has(l.id)).map((l) => l.id);
}
