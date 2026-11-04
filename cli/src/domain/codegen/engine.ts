// Port of internal/codegen/template_engine.go: the Handlebars-flavoured template engine. A
// Handlebars template is rewritten to a Go text/template (the regex preprocessor below, ported
// verbatim) and executed by the text/template port in goparse.ts / goexec.ts.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Template, TemplateAction, TemplateResult } from "../../models/template.ts";
import { globDir, goFsError } from "./glob.ts";
import { executeTemplate, FUNCTION_NAMES, GoExecError } from "./goexec.ts";
import { GoTemplateError, parseTemplate } from "./goparse.ts";
import { goQuote } from "./goquote.ts";
import { GoMap, type GoValue } from "./govalue.ts";
import { fields, goToLower, goTrimSpace } from "./helpers.ts";
import { compileRegexp, RegexpSyntaxError, replaceAll } from "./re2.ts";

/** The error `Engine.run` returns; carries the partial result Go also returns. */
export class TemplateRunError extends Error {
  constructor(
    message: string,
    readonly result: TemplateResult,
  ) {
    super(message);
    this.name = "TemplateRunError";
  }
}

// --- Handlebars -> Go template preprocessing ----------------------------------------------------

// RE2's \s is [\t\n\f\r ]; JS's is wider, so the class is spelled out.
const S = "[\\t\\n\\f\\r ]";

const reTriple = /\{\{\{([^}]+)\}\}\}/g;
const reIfOpen = new RegExp(`\\{\\{#if${S}+([^}]+)\\}\\}`, "g");
const reUnless = new RegExp(`\\{\\{#unless${S}+([^}]+)\\}\\}`, "g");
const reIfClose = /\{\{\/(if|unless)\}\}/g;
const reEachOpen = new RegExp(`\\{\\{#each${S}+([^}]+)\\}\\}`, "g");
const reEachClose = /\{\{\/each\}\}/g;
const reWithOpen = new RegExp(`\\{\\{#with${S}+([^}]+)\\}\\}`, "g");
const reWithClose = /\{\{\/with\}\}/g;
const reHelper = new RegExp(`\\{\\{(\\w+)${S}+([^}]+)\\}\\}`, "g");
const reVar = /\{\{([^#/!][^}]*)\}\}/g;
const reCommentBlock = /\{\{!--[\s\S]*?--\}\}/g;
const reCommentLine = /\{\{![^}]*\}\}/g;

const knownHelpers = new Set([
  "camelCase",
  "pascalCase",
  "kebabCase",
  "snakeCase",
  "upperCase",
  "lowerCase",
  "startCase",
]);

/** preprocessHBSExpr: one Handlebars expression token to its Go template spelling. */
export function preprocessHBSExpr(exprIn: string): string {
  const expr = goTrimSpace(exprIn);
  if (expr === "") return expr;
  if (expr.startsWith(".") || expr.startsWith("$")) return expr;
  if (expr === "true" || expr === "false" || expr === "nil") return expr;
  const c = expr.charCodeAt(0);
  if (c >= 48 && c <= 57) return expr;
  if (knownHelpers.has(expr)) return expr;
  return `index . "${expr}"`;
}

/** preprocessHandlebars: a Handlebars template to a Go text/template string. */
export function preprocessHandlebars(hbs: string): string {
  let s = hbs;
  s = s.replace(reTriple, (_m, inner: string) => `{{${preprocessHBSExpr(goTrimSpace(inner))}}}`);
  s = s.replace(reIfOpen, (_m, cond: string) => `{{if ${preprocessHBSExpr(goTrimSpace(cond))}}}`);
  s = s.replace(reUnless, (_m, cond: string) => {
    let expr = preprocessHBSExpr(goTrimSpace(cond));
    if (expr.includes(" ")) expr = `(${expr})`;
    return `{{if not ${expr}}}`;
  });
  s = s.replace(reIfClose, "{{end}}");
  s = s.replace(
    reEachOpen,
    (_m, iter: string) => `{{range ${preprocessHBSExpr(goTrimSpace(iter))}}}`,
  );
  s = s.replace(reEachClose, "{{end}}");
  s = s.replace(reWithOpen, (_m, obj: string) => `{{with ${preprocessHBSExpr(goTrimSpace(obj))}}}`);
  s = s.replace(reWithClose, "{{end}}");
  s = s.replace(reCommentBlock, "");
  s = s.replace(reCommentLine, "");
  s = s.replace(reHelper, (m, helperName: string, argsRaw: string) => {
    if (!knownHelpers.has(helperName)) return m;
    const args = fields(goTrimSpace(argsRaw));
    const processed = args.map((a) => {
      let expr = preprocessHBSExpr(a);
      if (expr.includes(" ")) expr = `(${expr})`;
      return expr;
    });
    return `{{${helperName} ${processed.join(" ")}}}`;
  });
  s = s.replace(reVar, (m, innerRaw: string) => {
    const inner = goTrimSpace(innerRaw);
    if (inner.startsWith(".") || /[ \t]/.test(inner)) return `{{${inner}}}`;
    switch (inner) {
      case "else":
      case "end":
      case "if":
      case "range":
      case "with":
      case "block":
      case "define":
      case "template":
      case "break":
      case "continue":
        return m;
    }
    return `{{index . "${inner}"}}`;
  });
  return s;
}

function isTruthy(sIn: string): boolean {
  const s = goTrimSpace(sIn);
  return s !== "" && s !== "false" && s !== "0";
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --- the engine ---------------------------------------------------------------------------------

export class Engine {
  /** Absolute path to the project root (one level above `.knowns`). */
  constructor(readonly projectRoot: string) {}

  /**
   * Executes tmpl with the supplied vars. With dryRun, paths are resolved and templates rendered
   * but nothing is written. Throws TemplateRunError (with Go's message) on the first failing action.
   */
  run(tmpl: Template, vars: Record<string, string>, dryRun: boolean): TemplateResult {
    const result: TemplateResult = { success: true, created: [], modified: [], skipped: [] };
    for (const action of tmpl.actions ?? []) {
      try {
        this.runAction(tmpl, action, vars, dryRun, result);
      } catch (e) {
        result.success = false;
        result.error = errMsg(e);
        throw new TemplateRunError(errMsg(e), result);
      }
    }
    return result;
  }

  private runAction(
    tmpl: Template,
    action: TemplateAction,
    vars: Record<string, string>,
    dryRun: boolean,
    result: TemplateResult,
  ): void {
    if ((action.when ?? "") !== "") {
      let ok: boolean;
      try {
        ok = this.evalWhen(action.when ?? "", vars);
      } catch (e) {
        throw new Error(`when expression ${goQuote(action.when ?? "")}: ${errMsg(e)}`);
      }
      if (!ok) return;
    }
    switch (action.type) {
      case "add":
        this.runAdd(tmpl, action, vars, dryRun, result);
        return;
      case "addMany":
        this.runAddMany(tmpl, action, vars, dryRun, result);
        return;
      case "modify":
        this.runModify(tmpl, action, vars, dryRun, result);
        return;
      case "append":
        this.runAppend(tmpl, action, vars, dryRun, result);
        return;
      default:
        throw new Error(`unknown action type: ${goQuote(action.type)}`);
    }
  }

  private pushTo(list: string[] | null | undefined, v: string): void {
    list?.push(v);
  }

  private runAdd(
    tmpl: Template,
    action: TemplateAction,
    vars: Record<string, string>,
    dryRun: boolean,
    result: TemplateResult,
  ): void {
    const actionPath = action.path ?? "";
    if (actionPath === "") throw new Error("add action requires a path");
    let destPath: string;
    try {
      destPath = this.renderString(actionPath, vars);
    } catch (e) {
      throw new Error(`render path ${goQuote(actionPath)}: ${errMsg(e)}`);
    }
    destPath = this.resolveDest(tmpl, destPath);
    if (action.skipIfExists && pathExists(destPath)) {
      this.pushTo(result.skipped, destPath);
      return;
    }
    const content = this.loadAndRenderTemplate(tmpl, action.template ?? "", vars);
    if (!dryRun) {
      try {
        writeFileMkdir(destPath, content);
      } catch (e) {
        throw new Error(`write ${destPath}: ${errMsg(e)}`);
      }
    }
    this.pushTo(result.created, destPath);
  }

  private runAddMany(
    tmpl: Template,
    action: TemplateAction,
    vars: Record<string, string>,
    dryRun: boolean,
    result: TemplateResult,
  ): void {
    const sourceDir = goJoin(tmpl.path ?? "", action.source ?? "");
    let globPat = action.globPattern ?? "";
    if (globPat === "") globPat = "**/*.hbs";
    let matches: string[];
    try {
      matches = globDir(sourceDir, globPat);
    } catch (e) {
      throw new Error(`glob ${goQuote(globPat)}: ${errMsg(e)}`);
    }
    let destBase = action.destination ?? "";
    if (destBase === "") destBase = tmpl.destination ?? "";
    try {
      destBase = this.renderString(destBase, vars);
    } catch (e) {
      throw new Error(`render destination ${goQuote(action.destination ?? "")}: ${errMsg(e)}`);
    }
    destBase = goJoin(this.projectRoot, destBase);

    for (const srcFile of matches) {
      let rel = relative(sourceDir, srcFile) || ".";
      try {
        rel = this.renderString(rel, vars);
      } catch (e) {
        // Go reassigns rel from the failed call, so the message quotes the empty string.
        throw new Error(`render file path ${goQuote("")}: ${errMsg(e)}`);
      }
      if (rel.endsWith(".hbs")) rel = rel.slice(0, -4);
      const destPath = goJoin(destBase, rel);
      if (action.skipIfExists && pathExists(destPath)) {
        this.pushTo(result.skipped, destPath);
        continue;
      }
      const content = this.loadAndRenderTemplate(tmpl, srcFile, vars);
      if (!dryRun) {
        try {
          writeFileMkdir(destPath, content);
        } catch (e) {
          throw new Error(`write ${destPath}: ${errMsg(e)}`);
        }
      }
      this.pushTo(result.created, destPath);
    }
  }

  private runModify(
    tmpl: Template,
    action: TemplateAction,
    vars: Record<string, string>,
    dryRun: boolean,
    result: TemplateResult,
  ): void {
    const actionPath = action.path ?? "";
    if (actionPath === "") throw new Error("modify action requires a path");
    let destPath: string;
    try {
      destPath = this.renderString(actionPath, vars);
    } catch (e) {
      throw new Error(`render path ${goQuote(actionPath)}: ${errMsg(e)}`);
    }
    destPath = this.resolveDest(tmpl, destPath);
    let existing: string;
    try {
      existing = readFileSync(destPath).toString("utf8");
    } catch (e) {
      throw new Error(`read ${destPath}: ${goFsError("open", destPath, e).message}`);
    }
    const replacement = this.loadAndRenderTemplate(tmpl, action.template ?? "", vars);
    let compiled: ReturnType<typeof compileRegexp>;
    try {
      compiled = compileRegexp(action.pattern ?? "");
    } catch (e) {
      if (e instanceof RegexpSyntaxError) {
        throw new Error(`compile pattern ${goQuote(action.pattern ?? "")}: ${e.message}`);
      }
      throw e;
    }
    const modified = replaceAll(compiled, existing, replacement);
    if (!dryRun) {
      try {
        writeFileMkdir(destPath, modified);
      } catch (e) {
        throw new Error(`write ${destPath}: ${errMsg(e)}`);
      }
    }
    this.pushTo(result.modified, destPath);
  }

  private runAppend(
    tmpl: Template,
    action: TemplateAction,
    vars: Record<string, string>,
    dryRun: boolean,
    result: TemplateResult,
  ): void {
    const actionPath = action.path ?? "";
    if (actionPath === "") throw new Error("append action requires a path");
    let destPath: string;
    try {
      destPath = this.renderString(actionPath, vars);
    } catch (e) {
      throw new Error(`render path ${goQuote(actionPath)}: ${errMsg(e)}`);
    }
    destPath = this.resolveDest(tmpl, destPath);
    const content = this.loadAndRenderTemplate(tmpl, action.template ?? "", vars);
    let existing = "";
    try {
      existing = readFileSync(destPath).toString("utf8");
    } catch {
      // may not exist yet
    }
    if (action.unique && existing.includes(content)) {
      this.pushTo(result.skipped, destPath);
      return;
    }
    let separator = action.separator ?? "";
    if (separator === "") separator = "\n";
    const final = existing === "" ? content : existing + separator + content;
    if (!dryRun) {
      try {
        writeFileMkdir(destPath, final);
      } catch (e) {
        throw new Error(`write ${destPath}: ${errMsg(e)}`);
      }
    }
    this.pushTo(result.modified, destPath);
  }

  private loadAndRenderTemplate(tmpl: Template, src: string, vars: Record<string, string>): string {
    if (src === "") return "";
    let raw: string;
    if (src.endsWith(".hbs") || /[/\\]/.test(src)) {
      const srcPath = isAbsolute(src) ? src : goJoin(tmpl.path ?? "", src);
      try {
        raw = readFileSync(srcPath).toString("utf8");
      } catch (e) {
        throw new Error(`read template file ${srcPath}: ${goFsError("open", srcPath, e).message}`);
      }
    } else {
      raw = src;
    }
    return this.renderString(raw, vars);
  }

  /**
   * ValidateTemplate: preprocesses a Handlebars template and checks that it parses as a Go
   * text/template. Returns the Go template, or throws the parse error exactly as Go reports it.
   */
  validateTemplate(hbs: string): string {
    const goTpl = preprocessHandlebars(hbs);
    parseTemplate("", goTpl, FUNCTION_NAMES);
    return goTpl;
  }

  /** RenderString: preprocess, parse and execute with vars as the data map. */
  renderString(hbs: string, vars: Record<string, string>): string {
    const goTpl = preprocessHandlebars(hbs);
    let trees: ReturnType<typeof parseTemplate>;
    try {
      trees = parseTemplate("", goTpl, FUNCTION_NAMES);
    } catch (e) {
      if (e instanceof GoTemplateError) {
        throw new Error(`parse template: ${e.message} (source: ${goQuote(hbs)})`);
      }
      throw e;
    }
    const data = new Map<string, GoValue>();
    for (const [k, v] of Object.entries(vars)) {
      const lower = goToLower(v);
      data.set(k, lower === "true" ? true : lower === "false" ? false : v);
    }
    try {
      return executeTemplate(trees, "", new GoMap(data));
    } catch (e) {
      if (e instanceof GoExecError) throw new Error(`execute template: ${e.message}`);
      throw e;
    }
  }

  private evalWhen(when: string, vars: Record<string, string>): boolean {
    let expr = goTrimSpace(when);
    if (expr.startsWith("{{") && expr.endsWith("}}")) expr = goTrimSpace(expr.slice(2, -2));
    let processed = preprocessHBSExpr(expr);
    if (processed.includes(" ")) processed = `(${processed})`;
    try {
      const result = this.renderString(`{{if ${processed}}}true{{else}}false{{end}}`, vars);
      return result === "true";
    } catch (err) {
      // Fall back: render the expression as a plain string.
      let val: string;
      try {
        val = this.renderString(when, vars);
      } catch {
        throw err;
      }
      return isTruthy(val);
    }
  }

  private resolveDest(tmpl: Template, dest: string): string {
    if (isAbsolute(dest)) return dest;
    let base = this.projectRoot;
    if ((tmpl.destination ?? "") !== "") base = goJoin(this.projectRoot, tmpl.destination ?? "");
    return goJoin(base, dest);
  }
}

/** filepath.Join: empty elements are ignored and an all-empty join is "". */
function goJoin(...parts: string[]): string {
  const nonEmpty = parts.filter((p) => p !== "");
  if (nonEmpty.length === 0) return "";
  return join(...nonEmpty);
}

function pathExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** writeFile: parent directories are created as needed (0755), the file is 0644. */
function writeFileMkdir(path: string, content: string): void {
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
  } catch (e) {
    throw goFsError("mkdir", firstNonDirectory(dir) ?? dir, notADirectory(e));
  }
  try {
    writeFileSync(path, content, { mode: 0o644 });
  } catch (e) {
    throw goFsError("open", path, e);
  }
}

/** The nearest existing ancestor (or dir itself) that is not a directory: where MkdirAll fails. */
function firstNonDirectory(dir: string): string | undefined {
  let cur = dir;
  for (;;) {
    try {
      if (!statSync(cur).isDirectory()) return cur;
      return undefined;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return undefined;
      cur = parent;
    }
  }
}

/** Node reports EEXIST where Go's MkdirAll reports ENOTDIR for a file in the way. */
function notADirectory(e: unknown): unknown {
  if ((e as NodeJS.ErrnoException).code === "EEXIST") {
    return Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
  }
  return e;
}
