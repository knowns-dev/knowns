// `knowns doc ...` (internal/cli/doc.go): list, view, create, edit, delete, hard-delete, history.
import { readSync } from "node:fs";
import type { Doc } from "../../models/doc.ts";
import type { Storage } from "../../storage/adapters.ts";
import { goTrimSpace } from "../../storage/core/util.ts";
import { goNow } from "../../storage/history/go-json.ts";
import { type FieldKind, shapeStruct } from "../../storage/stores/go-shape.ts";
import { arbitraryArgs, exactArgs, minimumNArgs } from "../core/args.ts";
import type { Command } from "../core/command.ts";
import { type CommandContext, defineCommand, type FlagSpec } from "../core/define.ts";
import { splitCSV } from "../core/helpers.ts";
import {
  type MarkdownBodyRenderer,
  markdownDisplayWidth,
  newTerminalMarkdownBodyRenderer,
  passthroughMarkdown,
  terminalMarkdownStyle,
  terminalWidth,
} from "../core/markdown.ts";
import { DEFAULT_PLAIN_ITEM_LIMIT, getPageOpts, isTTY, plainPageRequested } from "../core/pager.ts";
import {
  renderCmd,
  renderDim,
  renderHint,
  renderKeyValue,
  renderSectionHeader,
  renderSeparator,
  renderSuccess,
  renderWarning,
  StyleBold,
  StyleDim,
  StyleID,
  StyleInfo,
  StyleLabel,
  StyleTitle,
  StyleWarning,
} from "../core/plainoutput.ts";
import { docHistorySpec } from "./doc-history.ts";
import { docHooks } from "./doc-hooks.ts";
import {
  approximateDocTokens,
  containsTag,
  extractDocLines,
  extractDocSection,
  extractHeadings,
  formatGoTime,
  formatWithCommas,
  type Heading,
  padRight,
  pluralDocs,
  renderBlock,
  replaceDocSection,
  runeCount,
  slugifyTitle,
  stringWidth,
  truncateVisible,
} from "./doc-support.ts";

// --- JSON shape (models.Doc) ---------------------------------------------------------------------

const DOC_SPEC: ReadonlyArray<readonly [string, FieldKind]> = [
  ["id", "str"],
  ["path", { req: "" }],
  ["title", { req: "" }],
  ["description", "str"],
  ["content", "str"],
  ["tags", "list"],
  ["order", "ptr"],
  ["createdAt", { req: "" }],
  ["updatedAt", { req: "" }],
  ["folder", "str"],
  ["isImported", "bool"],
  ["importSource", "str"],
  ["canonicalHash", "str"],
];

/** The Doc as Go marshals it (omitempty rules, declared field order). */
export function docJSON(doc: Doc): Record<string, unknown> {
  return shapeStruct(doc as unknown as Record<string, unknown>, DOC_SPEC);
}

async function openStorage(ctx: CommandContext): Promise<Storage> {
  const { createStorage } = await import("../../storage/adapters.ts");
  return createStorage(await ctx.getStore());
}

// --- shared view flags ---------------------------------------------------------------------------

const viewFlags: FlagSpec[] = [
  { type: "bool", name: "toc", usage: "Show table of contents only", default: false },
  { type: "bool", name: "info", usage: "Show document stats without content", default: false },
  { type: "string", name: "section", usage: "Show specific section by number or title" },
  { type: "string", name: "line", usage: "Show specific lines (e.g., '42' or '10-20')" },
  {
    type: "bool",
    name: "smart",
    usage: "Auto-optimize reading for large documents",
    default: false,
  },
];

// --- doc list ------------------------------------------------------------------------------------

function docListTagsWidth(docs: readonly Doc[]): number {
  const cap = 28;
  let width = "TAGS".length;
  for (const d of docs) width = Math.max(width, stringWidth((d.tags ?? []).join(", ")));
  return Math.min(width, cap);
}

const renderTags = (tags: readonly string[]): string =>
  tags.map((t) => StyleLabel.render(t)).join(StyleDim.render(", "));

/** renderDocList: the styled document table. */
export function renderDocList(docs: readonly Doc[], width: number): string {
  const indent = 2;
  const gap = 2;
  const minPath = 20;
  const minTitle = 16;

  let pathW = "PATH".length;
  let titleW = "TITLE".length;
  for (const d of docs) {
    pathW = Math.max(pathW, stringWidth(d.path));
    titleW = Math.max(titleW, stringWidth(d.title));
  }
  const room = width - indent - gap * 2 - docListTagsWidth(docs);
  if (room < pathW + titleW) {
    const want = pathW + titleW;
    pathW = Math.max(Math.trunc((room * pathW) / want), minPath);
    titleW = Math.max(room - pathW, minTitle);
  }

  const sep = " ".repeat(gap);
  const pad = " ".repeat(indent);
  let out = `${pad}${[
    StyleBold.render(padRight("PATH", pathW)),
    StyleBold.render(padRight("TITLE", titleW)),
    StyleBold.render("TAGS"),
  ].join(sep)}\n`;
  out += `${pad}${renderSeparator(pathW + titleW + gap * 2 + docListTagsWidth(docs))}\n`;

  for (const d of docs) {
    const prefix = d.isImported ? StyleDim.render("[imported] ") : "";
    out += `${pad}${[
      StyleID.render(padRight(truncateVisible(d.path, pathW), pathW)),
      padRight(truncateVisible(d.title, titleW), titleW),
      prefix + renderTags(d.tags ?? []),
    ].join(sep)}\n`;
  }
  if (docs.length > 0) {
    out += `\n${pad}${StyleDim.render(`Total: ${docs.length} ${pluralDocs(docs.length)}`)}\n`;
  }
  return out;
}

/** The plain `doc list` body for one page (without the Total/PAGE footer logic of the caller). */
function plainDocList(
  docs: readonly Doc[],
  page: number,
  limit: number,
): { text: string; done: boolean } {
  const total = docs.length;
  if (page <= 0) page = 1;
  const start = (page - 1) * limit;
  let end = start + limit;
  if (start >= total) {
    const totalPages = Math.trunc((total + limit - 1) / limit);
    return { text: `PAGE: ${page}/${totalPages} (no more items)\n`, done: true };
  }
  if (end > total) end = total;
  let out = "";
  for (const d of docs.slice(start, end)) {
    out += `DOC: ${d.path}\n`;
    out += `  TITLE: ${d.title}\n`;
    if ((d.description ?? "") !== "") out += `  DESCRIPTION: ${d.description}\n`;
    if ((d.tags ?? []).length > 0) out += `  TAGS: ${(d.tags ?? []).join(", ")}\n`;
    if (d.isImported) out += `  IMPORTED FROM: ${d.importSource ?? ""}\n`;
    out += "\n";
  }
  out += `Total: ${total} ${pluralDocs(total)}\n`;
  if (total > limit) {
    const totalPages = Math.trunc((total + limit - 1) / limit);
    out += `PAGE: ${page}/${totalPages} (items ${start + 1}-${end} of ${total})\n`;
    if (page < totalPages) out += `Use --page ${page + 1} to see more results.\n`;
  }
  return { text: out, done: false };
}

const docListCmd = defineCommand({
  use: "list",
  short: "List all documentation files",
  flags: [{ type: "string", name: "tag", usage: "Filter by tag", default: "" }],
  async run(ctx) {
    const storage = await openStorage(ctx);
    const tagFilter = ctx.flags.string("tag");

    let docs: Doc[];
    try {
      docs = storage.docs.list();
    } catch (e) {
      throw new Error(`list docs: ${(e as Error).message}`);
    }
    // Go filters in place (docs[:0]): a nil list stays nil (JSON null), a emptied one is [].
    const wasNil = docs.length === 0;
    if (tagFilter !== "") docs = docs.filter((d) => containsTag(d.tags, tagFilter));

    if (ctx.json) {
      ctx.printJSON(docs.length === 0 && wasNil ? null : docs.map(docJSON));
      return;
    }
    if (docs.length === 0) {
      ctx.print(`${StyleDim.render("No documentation found.")}\n`);
      return;
    }
    if (ctx.plain) {
      let { page } = getPageOpts(ctx.cmd);
      const total = docs.length;
      const limit = plainPageRequested(ctx.cmd) ? DEFAULT_PLAIN_ITEM_LIMIT : Math.max(total, 1);
      if (page <= 0) page = 1;
      ctx.print(plainDocList(docs, page, limit).text);
    } else {
      ctx.print(renderDocList(docs, terminalWidth(ctx.env)));
    }
  },
});

// --- doc view ------------------------------------------------------------------------------------

function renderDocViewWithBodyRenderer(doc: Doc, renderBody: MarkdownBodyRenderer): string {
  let out = `${StyleTitle.render(`# ${doc.title}`)}\n`;
  if ((doc.description ?? "") !== "") out += `${renderBlock(StyleDim, doc.description ?? "")}\n`;
  if ((doc.tags ?? []).length > 0) {
    out += `${StyleDim.render("Tags:")} ${renderTags(doc.tags ?? [])}\n`;
  }
  out += `${renderSeparator(60)}\n`;
  out += `${renderBody(doc.content ?? "")}\n`;
  return out;
}

export const renderDocView = (doc: Doc): string =>
  renderDocViewWithBodyRenderer(doc, passthroughMarkdown);

export function renderDocViewMarkdown(
  doc: Doc,
  width: number,
  style: string = terminalMarkdownStyle(),
): string {
  return renderDocViewWithBodyRenderer(doc, newTerminalMarkdownBodyRenderer(width, style));
}

function renderDocInfo(doc: Doc): string {
  let out = `${renderKeyValue("Path", doc.path)}\n`;
  out += `${renderKeyValue("Title", doc.title)}\n`;
  if ((doc.description ?? "") !== "") out += `${renderKeyValue("Desc", doc.description ?? "")}\n`;
  out += `${renderKeyValue("Size", `${Buffer.byteLength(doc.content ?? "", "utf8")} bytes`)}\n`;
  out += `${StyleDim.render("Tags:")} ${renderTags(doc.tags ?? [])}\n`;
  out += `${renderKeyValue("Updated", formatGoTime(doc.updatedAt, "date"))}\n`;
  return out;
}

function renderDocTOC(title: string, headings: readonly Heading[]): string {
  let out = `${renderSectionHeader("Table of Contents:")} ${StyleInfo.render(title)}\n\n`;
  for (const h of headings) out += `${"  ".repeat(h.level - 1)}${h.text}\n`;
  return out;
}

function renderSmartDocSummary(doc: Doc): string {
  const content = doc.content ?? "";
  const headings = extractHeadings(content);
  const contentLen = runeCount(content);
  const approxTokens = approximateDocTokens(content);
  let baseLevel = 1;
  if (headings.length > 0) {
    baseLevel = Math.min(...headings.map((h) => h.level));
  }
  let out = `Document: ${doc.title}\n`;
  out += `${"=".repeat(50)}\n\n`;
  out += `Size: ${formatWithCommas(contentLen)} chars (~${formatWithCommas(approxTokens)} tokens)\n`;
  out += `Headings: ${headings.length}\n\n`;
  out += "Table of Contents:\n";
  out += `${"-".repeat(50)}\n`;
  headings.forEach((h, i) => {
    const indentLevel = Math.max(h.level - baseLevel + 1, 1);
    out += `${"  ".repeat(indentLevel)}${i + 1}. ${h.text}\n`;
  });
  out += "\nDocument is large. Use --section <number> to read a specific section.\n";
  return out;
}

async function runDocView(ctx: CommandContext, path: string): Promise<void> {
  const storage = await openStorage(ctx);

  let doc: Doc;
  try {
    doc = storage.docs.get(path);
  } catch {
    throw new Error(`doc "${path}" not found`);
  }

  const tocOnly = ctx.flags.bool("toc");
  const infoOnly = ctx.flags.bool("info");
  const section = ctx.flags.string("section");
  const lineParam = ctx.flags.string("line");
  const smart = ctx.flags.bool("smart");
  const plain = ctx.plain;
  const content = doc.content ?? "";

  if (ctx.json) {
    ctx.printJSON(docJSON(doc));
    return;
  }

  if (infoOnly) {
    if (plain) {
      let out = `PATH: ${doc.path}\nTITLE: ${doc.title}\n`;
      if ((doc.description ?? "") !== "") out += `DESCRIPTION: ${doc.description}\n`;
      out += `SIZE: ${Buffer.byteLength(content, "utf8")} bytes\n`;
      out += `TAGS: ${(doc.tags ?? []).join(", ")}\n`;
      out += `UPDATED: ${formatGoTime(doc.updatedAt, "date")}\n`;
      ctx.print(out);
    } else {
      ctx.print(renderDocInfo(doc));
    }
    return;
  }

  if (tocOnly) {
    const headings = extractHeadings(content);
    if (plain) {
      let out = `TOC: ${doc.title}\n\n`;
      for (const h of headings) out += `${"  ".repeat(h.level - 1)}${h.text}\n`;
      ctx.print(out);
    } else {
      ctx.print(renderDocTOC(doc.title, headings));
    }
    return;
  }

  if (section !== "") {
    const body = extractDocSection(content, section);
    if (body === "") throw new Error(`section "${section}" not found in ${doc.path}`);
    ctx.print(`${body}\n`);
    return;
  }

  if (lineParam !== "") {
    const { content: lineContent, label } = extractDocLines(content, lineParam);
    if (plain) ctx.print(`PATH: ${doc.path}\nLINES: ${label}\n\n${lineContent}\n`);
    else ctx.print(`Lines ${label} of ${doc.title}:\n\n${lineContent}\n`);
    return;
  }

  if (smart) {
    const tokenLimit = 2000;
    const approxTokens = approximateDocTokens(content);
    if (approxTokens > tokenLimit) {
      if (plain) {
        ctx.print(renderSmartDocSummary(doc));
      } else {
        ctx.print(
          `${renderWarning(`Document too large for smart mode (size: ${formatWithCommas(runeCount(content))} chars, ~${formatWithCommas(approxTokens)} tokens).`)}\n`,
        );
        ctx.print(
          `${renderHint(`Use ${renderCmd("--toc")} to view the table of contents, or ${renderCmd("--section")} to view a specific section.`)}\n`,
        );
      }
      return;
    }
  }

  if (plain) {
    let out = `PATH: ${doc.path}\nTITLE: ${doc.title}\n`;
    if ((doc.description ?? "") !== "") out += `DESCRIPTION: ${doc.description}\n`;
    if ((doc.tags ?? []).length > 0) out += `TAGS: ${(doc.tags ?? []).join(", ")}\n`;
    if (doc.isImported) out += `IMPORTED FROM: ${doc.importSource ?? ""}\n`;
    out += `UPDATED: ${formatGoTime(doc.updatedAt, "date")}\n\n`;
    out += `${content}\n`;
    ctx.printPaged(out);
  } else {
    const out = isTTY()
      ? renderDocViewMarkdown(doc, markdownDisplayWidth(), terminalMarkdownStyle(ctx.env))
      : renderDocView(doc);
    ctx.print(out);
  }
}

const docViewCmd = defineCommand({
  use: "view <path>",
  short: "View a documentation file",
  example: `  # Read a doc
  knowns doc view "ARCHITECTURE"

  # The same thing, since view is optional
  knowns doc "patterns/controller"

  # Table of contents first, then one section, for a long doc
  knowns doc "ARCHITECTURE" --toc`,
  args: exactArgs(1),
  flags: viewFlags,
  run: (ctx) => runDocView(ctx, ctx.args[0] ?? ""),
});

// --- doc create ----------------------------------------------------------------------------------

const docCreateCmd = defineCommand({
  use: "create <title>",
  short: "Create a new documentation file",
  example: `  # A core doc, at the root of .knowns/docs/
  knowns doc create "ARCHITECTURE" -d "System design"

  # A categorized doc, -f names the folder
  knowns doc create "Controller Pattern" -f patterns -t pattern,backend`,
  args: minimumNArgs(1),
  flags: [
    {
      type: "string",
      name: "description",
      shorthand: "d",
      usage: "Document description",
      default: "",
    },
    { type: "stringArray", name: "tag", shorthand: "t", usage: "Document tag (repeatable)" },
    {
      type: "string",
      name: "folder",
      shorthand: "f",
      usage: "Folder path within docs/",
      default: "",
    },
    { type: "string", name: "content", shorthand: "c", usage: "Initial content", default: "" },
  ],
  async run(ctx) {
    const title = ctx.args.join(" ");
    const storage = await openStorage(ctx);
    const description = ctx.flags.string("description");
    const tags = ctx.flags.strings("tag");
    const folder = ctx.flags.string("folder");
    const content = ctx.flags.string("content");

    const slug = slugifyTitle(title);
    const docPath = folder !== "" ? `${folder}/${slug}` : slug;

    const now = goNow();
    const doc: Doc = {
      path: docPath,
      title,
      createdAt: now,
      updatedAt: now,
    };
    if (description !== "") doc.description = description;
    doc.tags = tags;
    if (content !== "") doc.content = content;
    if (folder !== "") doc.folder = folder;

    const { mutateDocWithHistory } = await import("../../storage/history/index.ts");
    try {
      await mutateDocWithHistory(storage.ctx, null, doc, { actor: "cli", source: "cli" });
    } catch (e) {
      throw new Error(`create doc: ${(e as Error).message}`);
    }
    docHooks.indexDoc(storage, doc.path);

    ctx.print(`${renderSuccess(`Created doc: ${docPath}`)}\n`);
  },
});

// --- doc edit ------------------------------------------------------------------------------------

function trimSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, "");
}

const docEditCmd = defineCommand({
  use: "edit <path>",
  short: "Edit a documentation file",
  args: exactArgs(1),
  flags: [
    { type: "string", name: "title", shorthand: "t", usage: "New title", default: "" },
    { type: "string", name: "description", shorthand: "d", usage: "New description", default: "" },
    { type: "string", name: "tags", usage: "New tags (comma-separated)", default: "" },
    { type: "string", name: "path", usage: "Rename doc to a new path", default: "" },
    { type: "string", name: "content", shorthand: "c", usage: "Replace content", default: "" },
    { type: "string", name: "append", shorthand: "a", usage: "Append to content", default: "" },
    {
      type: "string",
      name: "section",
      usage: "Target section to replace (used with --content)",
      default: "",
    },
    {
      type: "string",
      name: "expected-hash",
      usage: "Expected canonical hash for optimistic concurrency",
      default: "",
    },
  ],
  async run(ctx) {
    const path = ctx.args[0] ?? "";
    const storage = await openStorage(ctx);

    let doc: Doc;
    try {
      doc = storage.docs.get(path);
    } catch {
      throw new Error(`doc "${path}" not found`);
    }
    const oldDoc: Doc = { ...doc }; // snapshot before changes

    if (ctx.flags.changed("title")) doc.title = ctx.flags.string("title");
    if (ctx.flags.changed("description")) {
      const v = ctx.flags.string("description");
      if (v === "") delete doc.description;
      else doc.description = v;
    }
    if (ctx.flags.changed("tags")) doc.tags = splitCSV(ctx.flags.string("tags"));
    const oldPath = path;
    if (ctx.flags.changed("path")) {
      const v = ctx.flags.string("path");
      doc.path = trimSlashes(v.endsWith(".md") ? v.slice(0, -3) : v);
    }

    const targetSection = ctx.flags.string("section");
    const expectedHash = ctx.flags.string("expected-hash");

    if (ctx.flags.changed("content")) {
      const v = ctx.flags.string("content");
      const next =
        targetSection !== "" ? replaceDocSection(doc.content ?? "", targetSection, v) : v;
      if (next === "") delete doc.content;
      else doc.content = next;
    }
    if (ctx.flags.changed("append")) {
      const v = ctx.flags.string("append");
      const cur = doc.content ?? "";
      let next: string;
      if (cur === "") next = v;
      else next = (cur.endsWith("\n") ? cur : `${cur}\n`) + v;
      if (next === "") delete doc.content;
      else doc.content = next;
    }

    doc.updatedAt = goNow();

    const { mutateDocWithHistory } = await import("../../storage/history/index.ts");
    try {
      await mutateDocWithHistory(storage.ctx, oldDoc, doc, {
        section: targetSection,
        actor: "cli",
        source: "cli",
        expectedHash,
      });
    } catch (e) {
      throw new Error(`update doc: ${(e as Error).message}`);
    }
    if (oldPath !== doc.path) docHooks.renameDoc(storage, doc.id ?? "", oldPath, doc.path);
    else docHooks.indexDoc(storage, doc.path);

    ctx.print(`${renderSuccess(`Updated doc: ${doc.path}`)}\n`);
  },
});

// --- doc delete ----------------------------------------------------------------------------------

/** fmt.Scanln(&answer): the first whitespace-delimited token of the next stdin line, or "". */
function scanAnswer(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(1);
  for (;;) {
    let n: number;
    try {
      n = readSync(0, buf, 0, 1, null);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") continue;
      if (code === "EOF") break;
      break;
    }
    if (n === 0 || buf[0] === 0x0a) break;
    chunks.push(Buffer.from(buf));
  }
  const line = Buffer.concat(chunks).toString("utf8");
  return /^[ \t\r]*(\S+)/.exec(line)?.[1] ?? "";
}

const docDeleteCmd = defineCommand({
  use: "delete <path>",
  short: "Delete a document permanently",
  args: exactArgs(1),
  flags: [
    {
      type: "bool",
      name: "dry-run",
      usage: "Preview what would be deleted without deleting",
      default: false,
    },
    { type: "bool", name: "force", usage: "Skip confirmation prompt", default: false },
    {
      type: "string",
      name: "expected-hash",
      usage: "Expected canonical hash for optimistic concurrency",
      default: "",
    },
  ],
  async run(ctx) {
    const storage = await openStorage(ctx);
    const dryRun = ctx.flags.bool("dry-run");
    const force = ctx.flags.bool("force");
    let expectedHash = ctx.flags.string("expected-hash");
    const target = ctx.args[0] ?? "";

    let doc: Doc;
    try {
      doc = storage.docs.get(target);
    } catch (e) {
      throw new Error(`delete doc: ${(e as Error).message}`);
    }
    if (goTrimSpace(expectedHash) === "") expectedHash = doc.canonicalHash ?? "";

    if (dryRun) {
      ctx.print(`${renderDim(`Would delete doc: ${doc.path} (${doc.title})`)}\n`);
      return;
    }

    if (!force) {
      ctx.print(
        `${StyleWarning.render("Delete doc")} ${StyleBold.render(doc.path)} (${doc.title})? ${StyleDim.render("This cannot be undone. (y/n)")}: `,
      );
      const answer = scanAnswer();
      if (answer !== "y" && answer !== "yes") {
        ctx.print(`${StyleDim.render("Aborted.")}\n`);
        return;
      }
    }

    const { deleteDocWithExpectedHash } = await import("../../storage/history/index.ts");
    try {
      await deleteDocWithExpectedHash(storage.ctx, target, {
        expectedHash,
        actor: "cli",
        source: "cli",
      });
    } catch (e) {
      throw new Error(`delete doc: ${(e as Error).message}`);
    }
    docHooks.removeDocID(storage, doc.id ?? "", doc.path);
    ctx.print(`${renderSuccess(`Deleted doc: ${doc.path}`)}\n`);
  },
});

// --- doc hard-delete -----------------------------------------------------------------------------

const docHardDeleteCmd = defineCommand({
  use: "hard-delete <path>",
  short: "Permanently purge a document and its verified history",
  args: exactArgs(1),
  flags: [
    { type: "bool", name: "yes", usage: "Confirm permanent purge", default: false },
    {
      type: "bool",
      name: "allow-hard-delete",
      usage: "Grant this local invocation trusted hard-delete capability",
      default: false,
    },
    {
      type: "string",
      name: "reason",
      usage: "Required audit reason for permanent purge",
      default: "",
    },
    {
      type: "string",
      name: "expected-hash",
      usage: "Expected canonical hash for optimistic concurrency",
      default: "",
    },
  ],
  async run(ctx) {
    const allowed = ctx.flags.bool("allow-hard-delete");
    const yes = ctx.flags.bool("yes");
    const reason = ctx.flags.string("reason");
    let expectedHash = ctx.flags.string("expected-hash");
    if (!allowed)
      throw new Error("doc hard-delete requires the trusted --allow-hard-delete capability");
    if (!yes) throw new Error("doc hard-delete requires --yes confirmation");
    if (goTrimSpace(reason) === "")
      throw new Error("doc hard-delete requires a non-empty --reason");

    const storage = await openStorage(ctx);
    const target = ctx.args[0] ?? "";
    let doc: Doc;
    try {
      doc = storage.docs.get(target);
    } catch (e) {
      throw new Error(`doc hard-delete: ${(e as Error).message}`);
    }
    if (goTrimSpace(expectedHash) === "") expectedHash = doc.canonicalHash ?? "";
    if (expectedHash !== (doc.canonicalHash ?? "")) {
      throw new Error("doc hard-delete: expected hash conflict");
    }
    const purge = docHooks.hardDelete;
    if (!purge) {
      throw new Error(
        "doc hard-delete: the lifecycle reconciler is not available in the TypeScript build yet",
      );
    }
    const base = doc.path.startsWith("docs/") ? doc.path.slice("docs/".length) : doc.path;
    const canonicalPath = `docs/${base.endsWith(".md") ? base.slice(0, -3) : base}.md`;
    try {
      await purge({
        storage,
        docID: doc.id ?? "",
        docPath: doc.path,
        canonicalPath,
        reason,
        expectedHash,
        actor: lifecycleActor(ctx.env),
      });
    } catch (e) {
      // A bootstrap failure (DocReconcileError, message "reconcile: <err>") reads
      // "doc hard-delete reconcile: <err>" in Go; the purge itself reads "doc hard-delete: <err>".
      const err = e as Error;
      if (err.name === "DocReconcileError") throw new Error(`doc hard-delete ${err.message}`);
      throw new Error(`doc hard-delete: ${err.message}`);
    }
    docHooks.removeDocID(storage, doc.id ?? "", doc.path);
    ctx.print(`Permanently deleted doc: ${doc.path}\n`);
  },
});

function lifecycleActor(env: Record<string, string | undefined>): string {
  const actor = goTrimSpace(env.USER ?? "");
  return actor !== "" ? actor : "cli";
}

// --- doc -----------------------------------------------------------------------------------------

export default defineCommand({
  use: "doc [path]",
  short: "Manage documentation",
  long: "Create, view, and edit project documentation.",
  example: `  # The everyday loop
  knowns doc list
  knowns doc create "Controller Pattern" -f patterns

  # Read one doc; the path alone is shorthand for "doc view"
  knowns doc "ARCHITECTURE"
  knowns doc "patterns/controller"`,
  args: arbitraryArgs,
  flags: viewFlags,
  async run(ctx) {
    const first = ctx.args[0];
    if (first === undefined) {
      (ctx.cmd as Command).help();
      return;
    }
    await runDocView(ctx, first);
  },
  subcommands: [
    docListCmd,
    docViewCmd,
    docCreateCmd,
    docEditCmd,
    docDeleteCmd,
    docHardDeleteCmd,
    docHistorySpec,
  ],
});
