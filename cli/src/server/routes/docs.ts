// internal/server/routes/docs.go
import {
  docHistoryJSON,
  docHistoryPageJSON,
  docVersionJSON,
} from "../../cli/commands/doc-history.ts";
import { docHooks } from "../../cli/commands/doc-hooks.ts";
import { findError } from "../../domain/tasklifecycle/errors.ts";
import type { Doc } from "../../models/doc.ts";
import { goNow, goTime } from "../../storage/history/go-json.ts";
import {
  HistoryConflictError,
  MutationConflictError,
  mutateDocWithHistory,
  restoreDoc,
  restoreDocSection,
} from "../../storage/history/index.ts";
import { type App, requireStore } from "../app.ts";
import { decodeStruct, type FieldType, GoJsonError, timeField } from "../gojson.ts";
import { errMessage, jsonResponse, type Router, respondError } from "../http.ts";
import { type Obj, readStruct } from "./support.ts";
import { bestEffort, historyPageQuery } from "./tasks.ts";

function formatRFC3339(ts: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(ts);
  if (!m) return ts;
  return `${m[1]}${m[2] === "+00:00" || m[2] === "-00:00" ? "Z" : m[2]}`;
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** toDocResponse: the nested shape the UI expects. */
export function toDocResponse(d: Doc): Obj {
  const meta: Obj = {};
  if (d.id) meta.id = d.id;
  if (d.canonicalHash) meta.canonicalHash = d.canonicalHash;
  meta.title = d.title;
  if (d.description) meta.description = d.description;
  meta.createdAt = formatRFC3339(d.createdAt);
  meta.updatedAt = formatRFC3339(d.updatedAt);
  meta.tags = d.tags ?? [];
  if (d.order !== undefined) meta.order = d.order;
  const out: Obj = {
    filename: `${baseName(d.path)}.md`,
    path: d.path,
    folder: d.folder ?? "",
    metadata: meta,
    content: d.content ?? "",
  };
  if (d.isImported) out.isImported = true;
  if (d.importSource) out.source = d.importSource;
  return out;
}

function decodedWildcard(raw: string): string {
  let r = raw;
  try {
    r = decodeURIComponent(raw);
  } catch {
    // keep raw
  }
  return r.startsWith("/") ? r.slice(1) : r;
}

function cleanDocPath(raw: string): string {
  let r = raw.replace(/^\/+/, "");
  if (r.endsWith(".md")) r = r.slice(0, -3);
  return r.replace(/^\/+|\/+$/g, "");
}

function splitHistoryPath(raw: string): string | undefined {
  if (!raw.endsWith("/history")) return undefined;
  const p = cleanDocPath(raw.slice(0, -"/history".length));
  return p === "" ? undefined : p;
}
function splitDiffPath(raw: string): [string, string] | undefined {
  if (!raw.endsWith("/diff")) return undefined;
  const w = raw.slice(0, -"/diff".length);
  const marker = "/history/";
  const idx = w.lastIndexOf(marker);
  if (idx < 0) return undefined;
  const p = cleanDocPath(w.slice(0, idx));
  const rev = w.slice(idx + marker.length).replace(/^\/+|\/+$/g, "");
  return p !== "" && rev !== "" ? [p, rev] : undefined;
}
function splitRevisionPath(raw: string): [string, string] | undefined {
  const marker = "/history/";
  const idx = raw.lastIndexOf(marker);
  if (idx < 0 || raw.endsWith("/diff")) return undefined;
  const p = cleanDocPath(raw.slice(0, idx));
  const rev = raw.slice(idx + marker.length).replace(/^\/+|\/+$/g, "");
  if (p === "" || rev === "" || rev.includes("/")) return undefined;
  return [p, rev];
}
function splitRestorePath(raw: string): string | undefined {
  if (!raw.endsWith("/restore")) return undefined;
  const p = cleanDocPath(raw.slice(0, -"/restore".length));
  return p === "" ? undefined : p;
}

/** slugifyTitle (routes/helpers.go): ASCII letters and digits, - _ and space become one hyphen. */
export function slugifyTitle(title: string): string {
  let out = "";
  let prevHyphen = false;
  for (const ch of title.toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      out += ch;
      prevHyphen = false;
    } else if (ch === "-" || ch === " " || ch === "_") {
      if (!prevHyphen) {
        out += "-";
        prevHyphen = true;
      }
    }
  }
  return out.replace(/^-+|-+$/g, "");
}

const DOC_FIELDS: Record<string, FieldType> = {
  id: "string",
  path: "string",
  title: "string",
  description: "string",
  content: "string",
  tags: "strings",
  order: "int",
  createdAt: timeField,
  updatedAt: timeField,
  folder: "string",
  isImported: "bool",
  importSource: "string",
  canonicalHash: "string",
};

const isConflict = (e: Error): e is HistoryConflictError | MutationConflictError =>
  e instanceof HistoryConflictError || e instanceof MutationConflictError;

export function registerDocs(r: Router, app: App): void {
  const guard = (h: Parameters<typeof requireStore>[1]) => requireStore(app, h);

  r.get(
    "/api/docs",
    guard(() => {
      try {
        const docs = app.need().docs.list();
        return jsonResponse(200, { docs: docs.map(toDocResponse) });
      } catch (e) {
        return respondError(500, errMessage(e));
      }
    }),
  );

  r.post(
    "/api/docs",
    guard(async (c) => {
      const s = app.need();
      const body = await readStruct(c, "Doc", DOC_FIELDS);
      if (!body.ok) return body.res;
      const v = body.v;
      const doc: Doc = {
        path: (v.path as string | undefined) ?? "",
        title: (v.title as string | undefined) ?? "",
        createdAt: (v.createdAt as string | undefined) ?? "",
        updatedAt: (v.updatedAt as string | undefined) ?? "",
      };
      if (v.id !== undefined) doc.id = v.id as string;
      if (v.description !== undefined) doc.description = v.description as string;
      if (v.content !== undefined) doc.content = v.content as string;
      if (v.tags !== undefined) doc.tags = v.tags as string[];
      if (v.order !== undefined) doc.order = v.order as number;
      if (v.folder !== undefined) doc.folder = v.folder as string;
      if (v.isImported !== undefined) doc.isImported = v.isImported as boolean;
      if (v.importSource !== undefined) doc.importSource = v.importSource as string;
      if (doc.path === "" && doc.title !== "") {
        const slug = slugifyTitle(doc.title);
        doc.path = doc.folder ? `${doc.folder}/${slug}` : slug;
      }
      if (doc.path === "") return respondError(400, "path or title is required");
      const now = goNow();
      if (doc.createdAt === "") doc.createdAt = now;
      doc.updatedAt = now;
      if (!doc.tags) doc.tags = [];
      try {
        await mutateDocWithHistory(s.ctx, null, doc, { actor: "webui", source: "webui" });
      } catch (e) {
        return respondError(500, errMessage(e));
      }
      await bestEffort(() => docHooks.indexDoc(s, doc.path));
      app.sse.broadcast({ type: "docs:updated", data: { path: doc.path } });
      return jsonResponse(201, toDocResponse(doc));
    }),
  );

  r.get(
    "/api/docs/*",
    guard(async (c) => {
      const s = app.need();
      const raw = decodedWildcard(c.params["*"] as string);
      const diff = splitDiffPath(raw);
      if (diff) {
        try {
          return jsonResponse(200, await s.versions.getDocRevisionDiff(diff[0], diff[1]));
        } catch (e) {
          return respondError(404, errMessage(e));
        }
      }
      const rev = splitRevisionPath(raw);
      if (rev) {
        try {
          return jsonResponse(
            200,
            docVersionJSON(await s.versions.getDocRevisionDetail(rev[0], rev[1])),
          );
        } catch (e) {
          return respondError(404, errMessage(e));
        }
      }
      const hist = splitHistoryPath(raw);
      if (hist !== undefined) {
        const meta = c.query("metadata");
        if (meta.toLowerCase() === "true" || c.query("offset") !== "" || c.query("limit") !== "") {
          const q = historyPageQuery(c);
          if (typeof q === "string") return respondError(400, q);
          try {
            return jsonResponse(
              200,
              docHistoryPageJSON(await s.versions.listDocHistoryMetadata(hist, q.offset, q.limit)),
            );
          } catch (e) {
            return respondError(500, errMessage(e));
          }
        }
        try {
          return jsonResponse(200, docHistoryJSON(await s.versions.getDocHistory(hist)));
        } catch (e) {
          return respondError(500, errMessage(e));
        }
      }
      try {
        return jsonResponse(200, toDocResponse(s.docs.get(cleanDocPath(raw))));
      } catch (e) {
        return respondError(404, errMessage(e));
      }
    }),
  );

  r.post(
    "/api/docs/*",
    guard(async (c) => {
      const s = app.need();
      const raw = decodedWildcard(c.params["*"] as string);
      const path = splitRestorePath(raw);
      if (path === undefined) return respondError(404, "unknown doc action");
      const body = await readStruct(c, "", {
        revision: "string",
        revisionId: "string",
        section: "string",
        mode: "string",
        expectedHash: "string",
      });
      if (!body.ok) return body.res;
      const v = body.v;
      const revision = ((v.revisionId as string) || (v.revision as string) || "") as string;
      if (revision === "") return respondError(400, "revision is required");
      const mode = ((v.mode as string | undefined) ?? "").trim().toLowerCase();
      const opts = {
        actor: "webui",
        source: "webui",
        expectedHash: (v.expectedHash as string | undefined) ?? "",
      };
      let doc: Doc;
      try {
        const section = (v.section as string | undefined) ?? "";
        if (section !== "" || mode === "section") {
          doc = await restoreDocSection(s.ctx, path, revision, section, opts);
        } else if (
          mode === "" ||
          mode === "document" ||
          mode === "whole_doc" ||
          mode === "whole-doc"
        ) {
          doc = await restoreDoc(s.ctx, path, revision, opts);
        } else {
          return respondError(400, `unknown restore mode: ${mode}`);
        }
      } catch (e) {
        return respondError(findError(e, isConflict) ? 409 : 500, errMessage(e));
      }
      await bestEffort(() => docHooks.indexDoc(s, doc.path));
      app.sse.broadcast({ type: "docs:updated", data: { path: doc.path } });
      let history: unknown = null;
      try {
        history = docHistoryJSON(await s.versions.getDocHistory(doc.path));
      } catch {
        history = null;
      }
      return jsonResponse(200, { doc: toDocResponse(doc), history, restored: true });
    }),
  );

  r.put(
    "/api/docs/*",
    guard(async (c) => {
      const s = app.need();
      const path = cleanDocPath(decodedWildcard(c.params["*"] as string));
      let existing: Doc;
      try {
        existing = s.docs.get(path);
      } catch (e) {
        return respondError(404, errMessage(e));
      }
      const oldDoc: Doc = { ...existing };
      const body = await readStruct(c, "", {
        title: "string",
        description: "string",
        content: "string",
        tags: "strings",
        path: "string",
        section: "string",
        expectedHash: "string",
      });
      if (!body.ok) return body.res;
      const v = body.v;
      const doc: Doc = { ...oldDoc, path, updatedAt: goNow() };
      const oldPath = path;
      if (v.title !== undefined) doc.title = v.title as string;
      if (v.description !== undefined) {
        if (v.description === "") delete doc.description;
        else doc.description = v.description as string;
      }
      if (v.content !== undefined) doc.content = v.content as string;
      if (v.tags !== undefined) doc.tags = v.tags as string[];
      if (v.path !== undefined) {
        let p = v.path as string;
        if (p.endsWith(".md")) p = p.slice(0, -3);
        doc.path = p.replace(/^\/+|\/+$/g, "");
      }
      if (!doc.tags) doc.tags = [];
      try {
        await mutateDocWithHistory(s.ctx, oldDoc, doc, {
          section: (v.section as string | undefined) ?? "",
          actor: "webui",
          source: "webui",
          expectedHash: (v.expectedHash as string | undefined) ?? "",
        });
      } catch (e) {
        return respondError(findError(e, isConflict) ? 409 : 500, errMessage(e));
      }
      if (oldPath !== doc.path) {
        await bestEffort(() => docHooks.renameDoc(s, doc.id ?? "", oldPath, doc.path));
        app.sse.broadcast({ type: "docs:updated", data: { oldPath, path: doc.path } });
      } else {
        await bestEffort(() => docHooks.indexDoc(s, doc.path));
        app.sse.broadcast({ type: "docs:updated", data: { path } });
      }
      return jsonResponse(200, toDocResponse(doc));
    }),
  );
}

void decodeStruct;
void GoJsonError;
void goTime;
