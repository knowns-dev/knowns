// `knowns doc history <path>` (internal/cli/doc.go docHistoryCmd and its renderers).
import type {
  DocChangeScope,
  DocVersion,
  DocVersionHistory,
  HistoryMetadataPage,
} from "../../models/version.ts";
import { sortKeysDeep } from "../../storage/core/util.ts";
import { type FieldKind, shapeStruct } from "../../storage/stores/go-shape.ts";
import { exactArgs } from "../core/args.ts";
import { defineCommand } from "../core/define.ts";
import { goQuote } from "../core/gofmt.ts";
import { StyleBold, StyleDim, StyleID } from "../core/plainoutput.ts";
import { formatGoTime, formatGoValue } from "./doc-support.ts";

// --- JSON shapes (models.DocVersion and friends: Go field order and omitempty) ---------------------

type Obj = Record<string, unknown>;
const spec = (fields: ReadonlyArray<readonly [string, FieldKind]>) => fields;

const SCOPE_SPEC = spec([
  ["type", { req: "" }],
  ["field", "str"],
  ["section", "str"],
  ["summary", "str"],
  ["oldBytes", "int"],
  ["newBytes", "int"],
  ["deltaBytes", "int"],
]);
const GAP_SPEC = spec([
  ["type", { req: "" }],
  ["reason", { req: "" }],
  ["count", { req: 0 }],
  ["beforeVersion", "str"],
  ["afterVersion", "str"],
  ["appliedAt", { req: "" }],
]);
const CHANGE_SPEC = spec([
  ["field", { req: "" }],
  ["oldValue", { req: null }],
  ["newValue", { req: null }],
]);
const VERSION_SPEC = spec([
  ["id", { req: "" }],
  ["docId", "str"],
  ["docPath", { req: "" }],
  ["currentPath", "str"],
  ["previousPath", "str"],
  ["version", { req: 0 }],
  ["timestamp", { req: "" }],
  ["author", "str"],
  ["actor", "str"],
  ["source", "str"],
  ["auditEventId", "str"],
  ["sessionId", "str"],
  ["baseHash", "str"],
  ["newHash", "str"],
  ["checkpoint", "bool"],
  ["changes", { req: null }],
  ["changedScopes", "list"],
  ["snapshot", { req: null }],
  ["schemaVersion", "int"],
  ["batchId", "str"],
  ["recordHash", "str"],
  ["operation", "str"],
  ["tombstone", "bool"],
  ["legacyUnverified", "bool"],
  ["legacyPath", "str"],
  ["legacyDigest", "str"],
]);
const HISTORY_SPEC = spec([
  ["docId", "str"],
  ["docPath", { req: "" }],
  ["currentPath", "str"],
  ["currentVersion", { req: 0 }],
  ["versions", { req: null }],
  ["retentionGaps", "list"],
  ["tailTruncated", "bool"],
]);
const META_SPEC = spec([
  ["schemaVersion", "int"],
  ["entityType", { req: "" }],
  ["entityId", { req: "" }],
  ["revision", { req: 0 }],
  ["id", { req: "" }],
  ["timestamp", { req: "" }],
  ["author", "str"],
  ["actor", "str"],
  ["source", "str"],
  ["auditEventId", "str"],
  ["sessionId", "str"],
  ["batchId", "str"],
  ["operation", "str"],
  ["tombstone", "bool"],
  ["lifecycleEventId", "str"],
  ["baseHash", "str"],
  ["newHash", "str"],
  ["prevRecordHash", "str"],
  ["recordHash", "str"],
  ["checkpoint", "bool"],
  ["legacyRevision", "int"],
  ["legacyId", "str"],
  ["legacy", "bool"],
  ["legacyUnverified", "bool"],
  ["legacyPath", "str"],
  ["legacyDigest", "str"],
  ["retentionGaps", "list"],
  ["currentPath", "str"],
  ["previousPath", "str"],
]);
const PAGE_SPEC = spec([
  ["entityType", "str"],
  ["entityId", "str"],
  ["docPath", "str"],
  ["currentPath", "str"],
  ["retentionGaps", "list"],
  ["offset", { req: 0 }],
  ["limit", { req: 0 }],
  ["hasMore", { req: false }],
  ["nextOffset", "ptr"],
  ["currentVersion", { req: 0 }],
  ["items", { req: null }],
  ["tailTruncated", "bool"],
]);

const mapList = (v: unknown, spec: ReadonlyArray<readonly [string, FieldKind]>): unknown =>
  Array.isArray(v) ? v.map((x) => shapeStruct(x as Obj, spec)) : v;

/** A DocVersion as Go marshals it. */
export function docVersionJSON(v: DocVersion): Obj {
  const o: Obj = { ...(v as unknown as Obj) };
  o.changes = Array.isArray(v.changes)
    ? v.changes.map((c) =>
        shapeStruct(
          {
            field: c.field,
            oldValue: sortKeysDeep(c.oldValue),
            newValue: sortKeysDeep(c.newValue),
          },
          CHANGE_SPEC,
        ),
      )
    : v.changes;
  o.changedScopes = mapList(v.changedScopes, SCOPE_SPEC);
  o.snapshot = v.snapshot === null || v.snapshot === undefined ? null : sortKeysDeep(v.snapshot);
  return shapeStruct(o, VERSION_SPEC);
}

/** A DocVersionHistory as Go marshals it. */
export function docHistoryJSON(h: DocVersionHistory): Obj {
  const o: Obj = { ...(h as unknown as Obj) };
  o.versions = Array.isArray(h.versions) ? h.versions.map(docVersionJSON) : h.versions;
  o.retentionGaps = mapList(h.retentionGaps, GAP_SPEC);
  return shapeStruct(o, HISTORY_SPEC);
}

/** A HistoryMetadataPage as Go marshals it. */
export function docHistoryPageJSON(p: HistoryMetadataPage): Obj {
  const o: Obj = { ...(p as unknown as Obj) };
  o.items = Array.isArray(p.items)
    ? p.items.map((item) => {
        const i: Obj = { ...(item as unknown as Obj) };
        i.retentionGaps = mapList(item.retentionGaps, GAP_SPEC);
        return shapeStruct(i, META_SPEC);
      })
    : p.items;
  o.retentionGaps = mapList(p.retentionGaps, GAP_SPEC);
  return shapeStruct(o, PAGE_SPEC);
}

function shortHash(hash: string): string {
  return hash.length <= 12 ? hash : hash.slice(0, 12);
}

export function formatDocHistoryMeta(v: DocVersion): string {
  const parts: string[] = [];
  if ((v.auditEventId ?? "") !== "") parts.push(`audit=${v.auditEventId}`);
  if ((v.sessionId ?? "") !== "") parts.push(`session=${v.sessionId}`);
  if ((v.baseHash ?? "") !== "") parts.push(`base=${shortHash(v.baseHash ?? "")}`);
  if ((v.newHash ?? "") !== "") parts.push(`new=${shortHash(v.newHash ?? "")}`);
  return parts.join(" ");
}

export function formatDocHistoryScope(scope: DocChangeScope): string {
  const parts: string[] = [];
  let kind = scope.type;
  if ((scope.field ?? "") !== "") kind += `:${scope.field}`;
  if ((scope.section ?? "") !== "") kind += `:${goQuote(scope.section ?? "")}`;
  parts.push(kind);
  if ((scope.summary ?? "") !== "") parts.push(`summary=${goQuote(scope.summary ?? "")}`);
  const oldBytes = scope.oldBytes ?? 0;
  const newBytes = scope.newBytes ?? 0;
  const delta = scope.deltaBytes ?? 0;
  if (oldBytes !== 0 || newBytes !== 0 || delta !== 0) {
    parts.push(`bytes=${oldBytes}->${newBytes} (${delta >= 0 ? "+" : "-"}${Math.abs(delta)})`);
  }
  return parts.join(" ");
}

export function renderPlainDocHistory(docPath: string, history: DocVersionHistory): string {
  let out = "";
  const path = history.docPath === "" ? docPath : history.docPath;
  out += `DOC: ${path}\n`;
  if ((history.docId ?? "") !== "") out += `DOC_ID: ${history.docId}\n`;
  if ((history.currentPath ?? "") !== "" && history.currentPath !== history.docPath) {
    out += `CURRENT_PATH: ${history.currentPath}\n`;
  }
  out += `VERSIONS: ${history.currentVersion}\n\n`;
  if (history.tailTruncated) out += "TAIL_TRUNCATED: true\n\n";
  const gaps = history.retentionGaps ?? [];
  for (const gap of gaps) {
    out += `RETENTION_GAP: type=${gap.type} reason=${gap.reason} count=${gap.count} before=${gap.beforeVersion ?? ""} after=${gap.afterVersion ?? ""} applied=${formatGoTime(gap.appliedAt, "rfc3339")}\n`;
  }
  if (gaps.length > 0) out += "\n";
  for (const v of history.versions ?? []) {
    out += `VERSION: ${v.id}\n`;
    out += `TIMESTAMP: ${formatGoTime(v.timestamp, "rfc3339")}\n`;
    out += `CHECKPOINT: ${v.checkpoint ? "true" : "false"}\n`;
    if ((v.actor ?? "") !== "") out += `ACTOR: ${v.actor}\n`;
    else if ((v.author ?? "") !== "") out += `AUTHOR: ${v.author}\n`;
    if ((v.source ?? "") !== "") out += `SOURCE: ${v.source}\n`;
    if ((v.auditEventId ?? "") !== "") out += `AUDIT_EVENT_ID: ${v.auditEventId}\n`;
    if ((v.sessionId ?? "") !== "") out += `SESSION_ID: ${v.sessionId}\n`;
    if ((v.baseHash ?? "") !== "") out += `BASE_HASH: ${v.baseHash}\n`;
    if ((v.newHash ?? "") !== "") out += `NEW_HASH: ${v.newHash}\n`;
    for (const scope of v.changedScopes ?? []) out += `  SCOPE: ${formatDocHistoryScope(scope)}\n`;
    for (const ch of v.changes ?? []) {
      out += `  CHANGE: ${ch.field}: ${formatGoValue(ch.oldValue)} -> ${formatGoValue(ch.newValue)}\n`;
    }
    out += "\n";
  }
  return out;
}

export function renderDocHistory(docPath: string, history: DocVersionHistory): string {
  let out = `${StyleID.render(docPath)} ${StyleDim.render(`— ${history.currentVersion} version(s)`)}\n\n`;
  const gaps = history.retentionGaps ?? [];
  for (const gap of gaps) {
    out += `${StyleDim.render("retention gap")} ${gap.reason} removed ${gap.count} version(s) before ${gap.afterVersion ?? ""}\n`;
  }
  if (gaps.length > 0) out += "\n";
  for (const v of history.versions ?? []) {
    let header = `${StyleDim.render(`[${v.id}]`)} ${formatGoTime(v.timestamp, "datetime")}`;
    if ((v.actor ?? "") !== "") header += StyleDim.render(" by ") + v.actor;
    else if ((v.author ?? "") !== "") header += StyleDim.render(" by ") + v.author;
    if ((v.source ?? "") !== "") header += StyleDim.render(" via ") + v.source;
    if (v.checkpoint) header += StyleDim.render(" checkpoint");
    out += `${header}\n`;
    if (
      (v.auditEventId ?? "") !== "" ||
      (v.sessionId ?? "") !== "" ||
      (v.baseHash ?? "") !== "" ||
      (v.newHash ?? "") !== ""
    ) {
      out += `  ${StyleDim.render("meta")} ${formatDocHistoryMeta(v)}\n`;
    }
    for (const scope of v.changedScopes ?? []) {
      out += `  ${StyleDim.render("scope")} ${formatDocHistoryScope(scope)}\n`;
    }
    for (const ch of v.changes ?? []) {
      out += `  ${StyleDim.render("•")} ${StyleBold.render(ch.field)}: ${formatGoValue(ch.oldValue)} → ${formatGoValue(ch.newValue)}\n`;
    }
    out += "\n";
  }
  return out;
}

function renderMetadataPage(docPath: string, page: HistoryMetadataPage): string {
  let out = `DOC: ${docPath}\nOFFSET: ${page.offset}\nLIMIT: ${page.limit}\nCURRENT_VERSION: ${page.currentVersion}\nHAS_MORE: ${page.hasMore ? "true" : "false"}\n`;
  if (page.tailTruncated) out += "TAIL_TRUNCATED: true\n";
  for (const item of page.items ?? []) {
    out += `VERSION: ${item.id}\nTIMESTAMP: ${formatGoTime(item.timestamp, "rfc3339")}\n`;
    if ((item.source ?? "") !== "") out += `SOURCE: ${item.source}\n`;
    if ((item.newHash ?? "") !== "") out += `NEW_HASH: ${item.newHash}\n`;
    out += "\n";
  }
  return out;
}

export const docHistorySpec = defineCommand({
  use: "history <path>",
  short: "Show version history of a document",
  args: exactArgs(1),
  flags: [
    {
      type: "bool",
      name: "metadata",
      usage: "List payload-free revision metadata",
      default: false,
    },
    { type: "int", name: "offset", usage: "Metadata page offset (newest first)", default: 0 },
    { type: "int", name: "limit", usage: "Metadata page size (0 means all)", default: 0 },
    {
      type: "string",
      name: "revision",
      usage: "Load one revision detail (vN or numeric)",
      default: "",
    },
  ],
  async run(ctx) {
    const { createStorage } = await import("../../storage/adapters.ts");
    const storage = createStorage(await ctx.getStore());
    const target = ctx.args[0] ?? "";
    const revision = ctx.flags.string("revision");
    const metadata = ctx.flags.bool("metadata");
    const offset = ctx.flags.int("offset");
    const limit = ctx.flags.int("limit");

    if (revision !== "") {
      let version: DocVersion;
      try {
        version = await storage.versions.getDocRevisionDetail(target, revision);
      } catch (e) {
        throw new Error(`get doc revision: ${(e as Error).message}`);
      }
      if (ctx.json) {
        ctx.printJSON(docVersionJSON(version));
      } else {
        const history: DocVersionHistory = {
          docPath: target,
          currentVersion: version.version,
          versions: [version],
        };
        if (ctx.plain) ctx.printPaged(renderPlainDocHistory(target, history));
        else ctx.print(renderDocHistory(target, history));
      }
      return;
    }

    if (metadata || offset !== 0 || limit !== 0) {
      let page: HistoryMetadataPage;
      try {
        page = await storage.versions.listDocHistoryMetadata(target, offset, limit);
      } catch (e) {
        throw new Error(`list doc history metadata: ${(e as Error).message}`);
      }
      if (ctx.json) ctx.printJSON(docHistoryPageJSON(page));
      else ctx.printPaged(renderMetadataPage(target, page));
      return;
    }

    let history: DocVersionHistory;
    try {
      history = await storage.versions.getDocHistory(target);
    } catch (e) {
      throw new Error(`get doc history: ${(e as Error).message}`);
    }
    if (ctx.json) {
      ctx.printJSON(docHistoryJSON(history));
      return;
    }
    if ((history.versions ?? []).length === 0) {
      ctx.print(`${StyleDim.render(`No version history for doc ${target}`)}\n`);
      return;
    }
    if (ctx.plain) ctx.printPaged(renderPlainDocHistory(target, history));
    else ctx.print(renderDocHistory(target, history));
  },
});
