// internal/server/routes/imports.go and internal/gitauth/url.go
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { goQuote } from "../../domain/validate/index.ts";
import { goJsonStringify } from "../../storage/core/util.ts";
import { type App, requireStore } from "../app.ts";
import { errMessage, jsonResponse, type Router, respondError } from "../http.ts";
import { goTop, type Obj, readStruct } from "./support.ts";

const META_FILE = "_import.json";

interface ImportMeta {
  source: string;
  type: string;
  ref?: string;
  lastSync?: string;
  importedAt?: string;
  lastCommitHash?: string;
}

interface Change {
  path: string;
  action: string;
}

// ---- gitauth ----------------------------------------------------------------------------------

function normalizeHost(host: string): string {
  const h = host.trim();
  try {
    const u = new URL(h);
    if (u.hostname !== "") return u.hostname.replace(/^\[|\]$/g, "");
  } catch {
    // not a URL
  }
  const m = /^(.*):\d+$/.exec(h);
  return (m ? (m[1] as string) : h).replace(/^\[|\]$/g, "");
}

export function tokenUsername(host: string): string {
  const h = normalizeHost(host).toLowerCase();
  if (h === "gitlab.com" || h.endsWith(".gitlab.com")) return "oauth2";
  if (h === "bitbucket.org" || h.endsWith(".bitbucket.org")) return "x-token-auth";
  return "x-access-token";
}

export function injectHttpsCredential(source: string, token: string, allowedHost: string): string {
  if (token === "" || allowedHost.trim() === "") return source;
  let u: URL;
  try {
    u = new URL(source);
  } catch {
    return source;
  }
  if (
    u.protocol.toLowerCase() !== "https:" ||
    u.hostname === "" ||
    u.username !== "" ||
    u.password !== ""
  ) {
    return source;
  }
  if (u.hostname.toLowerCase() !== normalizeHost(allowedHost).toLowerCase()) return source;
  u.username = tokenUsername(u.hostname);
  u.password = token;
  return u.toString();
}

// ---- helpers ------------------------------------------------------------------------------------

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

function writeMeta(dir: string, m: ImportMeta): void {
  const o: Obj = { source: m.source, type: m.type };
  if (m.ref) o.ref = m.ref;
  if (m.lastSync) o.lastSync = m.lastSync;
  if (m.importedAt) o.importedAt = m.importedAt;
  if (m.lastCommitHash) o.lastCommitHash = m.lastCommitHash;
  writeFileSync(join(dir, META_FILE), goJsonStringify(o), { mode: 0o644 });
}

function nameFromSource(source: string): string {
  let s = source.replace(/\/+$/, "");
  if (s.endsWith(".git")) s = s.slice(0, -4);
  const idx = s.lastIndexOf("/");
  if (idx >= 0) s = s.slice(idx + 1);
  return s === "" ? "import" : s;
}

function isGitURL(source: string): boolean {
  const s = source.trim();
  if (s.toLowerCase().startsWith("git@")) return s.includes(":");
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
  } catch {
    return false;
  }
}

const rfc3339Now = (): string => `${new Date().toISOString().slice(0, 19)}Z`;

function resultJson(
  name: string,
  source: string,
  type: string,
  dryRun: boolean,
  changes: Change[],
  warnings: string[],
): Obj {
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const c of changes) {
    if (c.action === "add") added++;
    else if (c.action === "update") updated++;
    else if (c.action === "skip") skipped++;
  }
  const out: Obj = {
    changes,
    dryRun,
    import: { name, source, type },
    success: true,
    summary: { added, skipped, updated },
  };
  if (warnings.length > 0) out.warnings = warnings;
  return out;
}

const GIT_TIMEOUT_MS = 5 * 60_000;

async function git(
  args: string[],
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    ...(cwd && { cwd }),
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Not in Go (its http.Server WriteTimeout bounded the request): a slow or huge remote must not
  // hold a request and a git process forever. The server sets idleTimeout 0 for SSE.
  const timer = setTimeout(() => proc.kill("SIGKILL"), GIT_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
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

  const gitCredential = (): { token: string; host: string } => {
    const env = process.env;
    if (env.KNOWNS_GIT_TOKEN && env.KNOWNS_GIT_HOST)
      return { token: env.KNOWNS_GIT_TOKEN, host: env.KNOWNS_GIT_HOST };
    const cfg = app.need().config;
    const str = (k: string): string => {
      try {
        const v = cfg.get(k);
        return typeof v === "string" ? v : "";
      } catch {
        return "";
      }
    };
    const token = str("git.token");
    const host = str("git.host");
    if (token !== "" && host !== "") return { token, host };
    let gh = env.KNOWNS_GITHUB_TOKEN ?? "";
    if (gh === "") gh = str("github.token");
    if (gh !== "") return { token: gh, host: "github.com" };
    return { token: "", host: "" };
  };
  const inject = (source: string): string => {
    const c = gitCredential();
    return injectHttpsCredential(source, c.token, c.host);
  };
  const lsRemote = async (source: string, ref: string): Promise<string> => {
    const res = await git(["ls-remote", "--", inject(source), ref === "" ? "HEAD" : ref]).catch(
      () => undefined,
    );
    if (!res || res.code !== 0) return "";
    const line = res.stdout.trim();
    const idx = line.indexOf("\t");
    return idx > 0 ? line.slice(0, idx) : "";
  };

  interface CloneResult {
    changes: Change[] | null;
    warnings: string[];
    upToDate: boolean;
  }
  const cloneImport = async (
    source: string,
    name: string,
    ref: string,
    cachedHash: string,
    dryRun: boolean,
  ): Promise<CloneResult> => {
    validateImportName(name);
    const remoteHash = await lsRemote(source, ref);
    if (remoteHash !== "" && remoteHash === cachedHash && !dryRun) {
      return { changes: [], warnings: [], upToDate: true };
    }
    const tmp = mkdtempSync(join(tmpdir(), "knowns-import-"));
    try {
      const args = ["clone", "--depth", "1"];
      if (ref !== "") args.push("--branch", ref);
      args.push("--", inject(source), tmp);
      const res = await git(args);
      if (res.code !== 0) {
        let msg = res.stderr.trim();
        const { token } = gitCredential();
        if (token !== "") msg = msg.replaceAll(token, "[REDACTED]");
        const s = msg.toLowerCase();
        if (
          s.includes("authentication failed") ||
          s.includes("could not read username") ||
          s.includes("terminal prompts disabled") ||
          s.includes("403") ||
          s.includes("401")
        ) {
          throw new Error(
            `authentication failed for ${source}. Set KNOWNS_GIT_TOKEN env var, run 'knowns config set git.token <token>', or use an SSH URL (e.g. git@host:owner/repo.git) instead`,
          );
        }
        throw new Error(`git clone failed: ${msg}`);
      }
      const knownsDir = join(tmp, ".knowns");
      if (!existsSync(knownsDir)) {
        return {
          changes: null,
          warnings: [`no .knowns directory found in ${source}`],
          upToDate: false,
        };
      }
      const changes: Change[] = [];
      const warnings: string[] = [];
      const destBase = join(importsDir(), name);
      for (const sub of ["docs", "templates"]) {
        const srcDir = join(knownsDir, sub);
        if (!existsSync(srcDir)) continue;
        const walk = (d: string): void => {
          for (const n of sortedNames(d)) {
            const p = join(d, n);
            const lst = lstatSync(p);
            if (lst.isDirectory()) {
              walk(p);
              continue;
            }
            if (lst.isSymbolicLink()) {
              warnings.push(`skipped symbolic link ${p}`);
              continue;
            }
            let rel = relative(knownsDir, p).split(sep).join("/");
            if (sub === "docs") rel = `docs/${name}/${rel.replace(/^docs\//, "")}`;
            const dest = join(destBase, rel);
            let srcData: Buffer;
            try {
              srcData = readFileSync(p);
            } catch (e) {
              warnings.push(`could not read ${rel}: ${errMessage(e)}`);
              continue;
            }
            let action = "add";
            try {
              action = srcData.equals(readFileSync(dest)) ? "skip" : "update";
            } catch {
              // destination missing
            }
            changes.push({ path: rel, action });
            if (!dryRun && action !== "skip") {
              mkdirSync(dirname(dest), { recursive: true, mode: 0o755 });
              copyFileSync(p, dest);
            }
          }
        };
        walk(srcDir);
      }
      if (!dryRun) {
        mkdirSync(destBase, { recursive: true, mode: 0o755 });
        const now = rfc3339Now();
        const existing = readMeta(destBase);
        try {
          writeMeta(destBase, {
            source,
            type: "git",
            ref,
            lastSync: now,
            importedAt: existing?.importedAt || now,
            lastCommitHash: remoteHash,
          });
        } catch (e) {
          warnings.push(`could not write import metadata: ${errMessage(e)}`);
        }
      }
      return { changes, warnings, upToDate: false };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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

  r.post(
    "/api/imports",
    guard(async (c) => {
      const body = await readStruct(c, "addImportRequest", {
        source: "string",
        name: "string",
        type: "string",
        ref: "string",
        link: "bool",
        dryRun: "bool",
      });
      if (!body.ok) return body.res;
      const v = body.v;
      const source = (v.source as string | undefined) ?? "";
      if (source === "") return respondError(400, "source is required");
      const name = (v.name as string | undefined) || nameFromSource(source);
      try {
        validateImportName(name);
      } catch (e) {
        return respondError(400, errMessage(e));
      }
      const dryRun = v.dryRun === true;
      if (isGitURL(source)) {
        try {
          const res = await cloneImport(
            source,
            name,
            (v.ref as string | undefined) ?? "",
            "",
            dryRun,
          );
          return jsonResponse(
            201,
            resultJson(name, source, "git", dryRun, res.changes ?? [], res.warnings),
          );
        } catch (e) {
          return respondError(500, errMessage(e));
        }
      }
      const dest = join(importsDir(), name);
      try {
        mkdirSync(dest, { recursive: true, mode: 0o755 });
      } catch (e) {
        return respondError(500, `create import dir: ${errMessage(e)}`);
      }
      const type = (v.type as string | undefined) || "local";
      const now = rfc3339Now();
      try {
        writeMeta(dest, { source, type, lastSync: now, importedAt: now });
      } catch {
        // ignored, as in Go
      }
      return jsonResponse(201, resultJson(name, source, type, dryRun, [], []));
    }),
  );

  r.delete(
    "/api/imports/{name}",
    guard((c) => {
      const name = c.params.name as string;
      try {
        validateImportName(name);
        rmSync(join(importsDir(), name), { recursive: true, force: true });
      } catch (e) {
        const bad = errMessage(e).startsWith("invalid import name");
        return respondError(bad ? 400 : 500, errMessage(e));
      }
      return jsonResponse(200, { filesDeleted: true, success: true });
    }),
  );

  r.post(
    "/api/imports/sync",
    guard(() => jsonResponse(200, { status: "synced" })),
  );

  r.post(
    "/api/imports/sync-all",
    guard(async () => {
      let names: string[];
      try {
        names = readdirSync(importsDir(), { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .map((e) => e.name)
          .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          return jsonResponse(200, {
            dryRun: false,
            results: [],
            success: true,
            summary: { failed: 0, successful: 0, total: 0 },
          });
        }
        return respondError(500, `read imports: ${errMessage(e)}`);
      }
      const results: Obj[] = [];
      let successful = 0;
      let failed = 0;
      for (const name of names) {
        const meta = readMeta(join(importsDir(), name));
        if (!meta || !isGitURL(meta.source)) {
          const o: Obj = {
            name,
            source: meta?.source ?? "",
            type: meta?.type ?? "",
            success: true,
          };
          results.push(o);
          successful++;
          continue;
        }
        try {
          const res = await cloneImport(
            meta.source,
            name,
            meta.ref ?? "",
            meta.lastCommitHash ?? "",
            false,
          );
          if (res.upToDate) {
            results.push({
              name,
              source: meta.source,
              type: "git",
              success: true,
              summary: { upToDate: true },
            });
            successful++;
            continue;
          }
          let added = 0;
          let updated = 0;
          let skipped = 0;
          for (const ch of res.changes ?? []) {
            if (ch.action === "add") added++;
            else if (ch.action === "update") updated++;
            else if (ch.action === "skip") skipped++;
          }
          const summary: Obj = { added, skipped, updated };
          if (res.warnings.length > 0) summary.warnings = res.warnings;
          results.push({
            name,
            source: meta.source,
            type: "git",
            success: true,
            summary: goTop(summary),
          });
          successful++;
          app.sse.broadcast({ type: "imports:synced", data: { name } });
        } catch (e) {
          results.push({
            name,
            source: meta.source,
            type: "git",
            success: false,
            error: errMessage(e),
          });
          failed++;
        }
      }
      const total = successful + failed;
      app.sse.broadcast({ type: "imports:sync-all", data: { total } });
      return jsonResponse(200, {
        dryRun: false,
        results,
        success: true,
        summary: { failed, successful, total },
      });
    }),
  );

  r.post(
    "/api/imports/{name}/sync",
    guard(async (c) => {
      const name = c.params.name as string;
      try {
        validateImportName(name);
      } catch (e) {
        return respondError(400, errMessage(e));
      }
      const dir = join(importsDir(), name);
      if (!existsSync(dir)) return respondError(404, `import not found: ${name}`);
      const meta = readMeta(dir);
      if (!meta || !isGitURL(meta.source)) {
        app.sse.broadcast({ type: "imports:synced", data: { name } });
        return jsonResponse(
          200,
          resultJson(name, meta?.source ?? "", meta?.type ?? "", false, [], []),
        );
      }
      try {
        const res = await cloneImport(
          meta.source,
          name,
          meta.ref ?? "",
          meta.lastCommitHash ?? "",
          false,
        );
        app.sse.broadcast({ type: "imports:synced", data: { name } });
        if (res.upToDate) {
          return jsonResponse(200, {
            import: { name, source: meta.source, type: "git" },
            success: true,
            upToDate: true,
          });
        }
        return jsonResponse(
          200,
          resultJson(name, meta.source, "git", false, res.changes ?? [], res.warnings),
        );
      } catch (e) {
        return respondError(500, `sync failed: ${errMessage(e)}`);
      }
    }),
  );
}
