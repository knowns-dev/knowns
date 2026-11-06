// internal/server/routes/imports.go, read side only. Import management was removed (D8, extended to
// the HTTP API by TSR-0MM0QC): content already in .knowns/imports stays listable and viewable, but
// the server no longer adds, removes or syncs imports. POST /api/imports, DELETE /api/imports/{name}
// and the sync routes are not registered, so they answer as any unknown route does (405 where a
// GET exists on the path, 404 otherwise), and no git process or recursive delete can be started
// through the server.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { goQuote } from "../../domain/validate/index.ts";
import { type App, requireStore } from "../app.ts";
import { errMessage, jsonResponse, type Router, respondError } from "../http.ts";
import type { Obj } from "./support.ts";

const META_FILE = "_import.json";

interface ImportMeta {
  source: string;
  type: string;
  ref?: string;
  lastSync?: string;
  importedAt?: string;
  lastCommitHash?: string;
}

function validateImportName(name: string): void {
  if (name === "" || name === "." || name === ".." || isAbsolute(name) || /[/\\\0]/.test(name)) {
    throw new Error(`invalid import name ${goQuote(name)}: must be a single path segment`);
  }
}

function sortedNames(dir: string): string[] {
  return readdirSync(dir).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let names: string[];
    try {
      names = sortedNames(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      let st: import("node:fs").Stats;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

function readMeta(dir: string): ImportMeta | undefined {
  try {
    const v = JSON.parse(readFileSync(join(dir, META_FILE), "utf8")) as Obj;
    if (v === null || typeof v !== "object") return undefined;
    const s = (k: string): string => (typeof v[k] === "string" ? (v[k] as string) : "");
    return {
      source: s("source"),
      type: s("type"),
      ref: s("ref"),
      lastSync: s("lastSync"),
      importedAt: s("importedAt"),
      lastCommitHash: s("lastCommitHash"),
    };
  } catch {
    return undefined;
  }
}

export function registerImports(r: Router, app: App): void {
  const guard = (h: Parameters<typeof requireStore>[1]) => requireStore(app, h);
  const importsDir = (): string => join(app.need().store.root, "imports");

  const entry = (name: string, includeFiles: boolean): Obj => {
    const dir = join(importsDir(), name);
    let type = "local";
    let source = "";
    let ref = "";
    let lastSync = "";
    let importedAt = "";
    const meta = readMeta(dir);
    if (meta) {
      source = meta.source;
      if (meta.type !== "") type = meta.type;
      ref = meta.ref ?? "";
      lastSync = meta.lastSync ?? "";
      importedAt = meta.importedAt ?? "";
    }
    const files = collectFiles(dir).filter((f) => f !== META_FILE);
    const o: Obj = { name };
    if (source) o.source = source;
    if (type) o.type = type;
    if (ref) o.ref = ref;
    o.link = false;
    o.autoSync = false;
    if (lastSync) o.lastSync = lastSync;
    if (importedAt) o.importedAt = importedAt;
    o.fileCount = files.length;
    if (includeFiles && files.length > 0) o.files = files;
    return o;
  };

  r.get(
    "/api/imports",
    guard(() => {
      let names: string[];
      try {
        names = readdirSync(importsDir(), { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .map((e) => e.name)
          .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT")
          return jsonResponse(200, { count: 0, imports: [] });
        return respondError(500, errMessage(e));
      }
      const imports = names.map((n) => entry(n, false));
      return jsonResponse(200, { count: imports.length, imports });
    }),
  );

  r.get(
    "/api/imports/{name}",
    guard((c) => {
      const name = c.params.name as string;
      try {
        validateImportName(name);
      } catch (e) {
        return respondError(400, errMessage(e));
      }
      if (!existsSync(join(importsDir(), name)))
        return respondError(404, `import not found: ${name}`);
      return jsonResponse(200, { import: entry(name, true) });
    }),
  );
}
