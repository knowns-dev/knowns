// internal/server/routes/templates.go and validate.go
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { run as runValidate } from "../../domain/validate/index.ts";
import type { Template, TemplateAction, TemplatePrompt } from "../../models/template.ts";
import { resolveSafe } from "../../storage/core/safe-path.ts";
import { type App, requireStore } from "../app.ts";
import { errMessage, jsonResponse, type Router, respondError } from "../http.ts";
import { goMap, goTop, type Obj, readStruct } from "./support.ts";

const caseParts = (s: string): string[] => s.split(/[-_ ]/).filter((p) => p !== "");

function toSnakeCase(s: string): string {
  let out = "";
  let i = 0;
  for (const ch of s) {
    if (ch >= "A" && ch <= "Z") {
      if (i > 0) out += "_";
      out += ch.toLowerCase();
    } else if (ch === "-" || ch === " ") out += "_";
    else out += ch;
    i += Buffer.byteLength(ch);
  }
  return out;
}
function toKebabCase(s: string): string {
  let out = "";
  let i = 0;
  for (const ch of s) {
    if (ch >= "A" && ch <= "Z") {
      if (i > 0) out += "-";
      out += ch.toLowerCase();
    } else if (ch === "_" || ch === " ") out += "-";
    else out += ch;
    i += Buffer.byteLength(ch);
  }
  return out;
}
const cap = (p: string): string => p.slice(0, 1).toUpperCase() + p.slice(1).toLowerCase();
const toCamelCase = (s: string): string =>
  caseParts(s)
    .map((p, i) => (i === 0 ? p.toLowerCase() : cap(p)))
    .join("");
const toPascalCase = (s: string): string => caseParts(s).map(cap).join("");

/** Ordered Template JSON (Go struct order, omitempty applied). */
function templateJson(t: Template): Obj {
  const out: Obj = { name: t.name };
  for (const k of ["description", "version", "author", "destination", "doc"] as const) {
    if (t[k]) out[k] = t[k];
  }
  if (t.prompts && t.prompts.length > 0) out.prompts = t.prompts.map(promptJson);
  if (t.actions && t.actions.length > 0) out.actions = t.actions.map(actionJson);
  if (t.messages) {
    const m: Obj = {};
    if (t.messages.success) m.success = t.messages.success;
    if (t.messages.failure) m.failure = t.messages.failure;
    out.messages = m;
  }
  if (t.path) out.path = t.path;
  if (t.imported) out.imported = true;
  if (t.importName) out.importName = t.importName;
  return out;
}
function promptJson(p: TemplatePrompt): Obj {
  const o: Obj = { name: p.name, type: p.type, message: p.message };
  for (const k of ["validate", "initial", "hint", "when"] as const) if (p[k]) o[k] = p[k];
  if (p.choices && p.choices.length > 0) {
    o.choices = p.choices.map((c) => {
      const x: Obj = { title: c.title, value: c.value };
      if (c.description) x.description = c.description;
      if (c.selected) x.selected = true;
      return x;
    });
  }
  return o;
}
function actionJson(a: TemplateAction): Obj {
  const o: Obj = { type: a.type };
  for (const k of ["template", "path"] as const) if (a[k]) o[k] = a[k];
  if (a.skipIfExists) o.skipIfExists = true;
  for (const k of ["when", "source", "destination", "globPattern", "pattern"] as const)
    if (a[k]) o[k] = a[k];
  if (a.unique) o.unique = true;
  if (a.separator) o.separator = a.separator;
  return o;
}

function replaceAll(
  s: string,
  vars: Record<string, string>,
  extra?: (k: string, v: string) => [string, string][],
): string {
  let out = s;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v);
    for (const [from, to] of extra?.(k, v) ?? []) out = out.replaceAll(from, to);
  }
  return out;
}

/** filepath.Join(a, b) with Go's Clean semantics (the path is only echoed in JSON). */
function joinPath(a: string, b: string): string {
  return join(a, b);
}

export function registerTemplates(r: Router, app: App): void {
  const guard = (h: Parameters<typeof requireStore>[1]) => requireStore(app, h);

  r.get(
    "/api/templates",
    guard(() => {
      try {
        const items = app
          .need()
          .templates.list()
          .map((t) => {
            const o: Obj = { name: t.name };
            if (t.description) o.description = t.description;
            if (t.doc) o.doc = t.doc;
            o.promptCount = (t.prompts ?? []).length;
            o.fileCount = (t.actions ?? []).length;
            if (t.imported) o.isImported = true;
            if (t.importName) o.source = t.importName;
            return o;
          });
        return jsonResponse(200, { count: items.length, templates: items });
      } catch (e) {
        return respondError(500, errMessage(e));
      }
    }),
  );

  r.post(
    "/api/templates",
    guard(async (c) => {
      const s = app.need();
      const body = await readStruct(c, "createTemplateRequest", {
        name: "string",
        description: "string",
      });
      if (!body.ok) return body.res;
      const name = (body.v.name as string | undefined) ?? "";
      if (name === "") return respondError(400, "name is required");
      try {
        s.templates.create(name, (body.v.description as string | undefined) ?? "");
        const tmpl = s.templates.get(name);
        app.sse.broadcast({ type: "templates:created", data: { name } });
        return jsonResponse(201, templateJson(tmpl));
      } catch (e) {
        return respondError(500, errMessage(e));
      }
    }),
  );

  r.post(
    "/api/templates/preview",
    guard(async (c) => {
      const s = app.need();
      const body = await readStruct(c, "previewTemplateRequest", {
        name: "string",
        variables: "stringMap",
        templateFile: "string",
      });
      if (!body.ok) return body.res;
      const vars = body.v.variables as Record<string, string> | undefined;
      let tmpl: Template;
      try {
        tmpl = s.templates.get((body.v.name as string | undefined) ?? "");
      } catch (e) {
        return respondError(404, `template not found: ${errMessage(e)}`);
      }
      const templateFile = (body.v.templateFile as string | undefined) || "main.hbs";
      let abs: string;
      try {
        abs = resolveSafe(tmpl.path ?? "", templateFile);
      } catch {
        return respondError(400, "invalid template file path");
      }
      let content: string;
      try {
        content = readFileSync(abs, "utf8");
      } catch {
        return respondError(404, `template file not found: ${templateFile}`);
      }
      const rendered = vars ? replaceAll(content, vars) : content;
      let dest = templateFile;
      for (const action of tmpl.actions ?? []) {
        if (action.template === templateFile && action.path) {
          dest = action.path;
          if (vars) {
            dest = replaceAll(dest, vars, (k, v) => [
              [`{{kebabCase ${k}}}`, v],
              [`{{camelCase ${k}}}`, v],
              [`{{pascalCase ${k}}}`, v],
            ]);
          }
          if (tmpl.destination) dest = joinPath(tmpl.destination, dest);
          break;
        }
      }
      return jsonResponse(200, { files: [{ path: dest, content: rendered }] });
    }),
  );

  r.get(
    "/api/templates/{name}",
    guard((c) => {
      try {
        const tmpl = app.need().templates.get(c.params.name as string);
        const prompts = (tmpl.prompts ?? []).map((p) => {
          const o: Obj = {
            name: p.name,
            message: p.message,
            type: p.type,
            required: p.validate === "required",
          };
          if (p.initial) o.default = p.initial;
          if (p.choices && p.choices.length > 0) {
            o.choices = p.choices.map((ch) => ({ value: ch.value, label: ch.title }));
          }
          return o;
        });
        const files = (tmpl.actions ?? []).map((a) => {
          const o: Obj = { type: a.type };
          if (a.template) o.template = a.template;
          if (a.path) {
            o.destination = a.path;
            o.path = a.path;
          }
          if (a.source) o.source = a.source;
          if (a.globPattern) o.globPattern = a.globPattern;
          if (a.skipIfExists) o.skipIfExists = true;
          if (a.when) o.when = a.when;
          return o;
        });
        const detail: Obj = {
          name: tmpl.name,
          description: tmpl.description ?? "",
          doc: tmpl.doc ?? "",
          destination: tmpl.destination ?? "",
          prompts,
          files,
        };
        if (tmpl.messages) detail.messages = templateJson(tmpl).messages;
        return jsonResponse(200, { template: goTop(detail) });
      } catch (e) {
        return respondError(404, errMessage(e));
      }
    }),
  );

  r.post(
    "/api/templates/{name}/run",
    guard(async (c) => {
      const s = app.need();
      const name = c.params.name as string;
      const body = await readStruct(c, "runTemplateRequest", {
        variables: "stringMap",
        dryRun: "bool",
      });
      if (!body.ok) return body.res;
      const vars = body.v.variables as Record<string, string> | undefined;
      const dryRun = body.v.dryRun === true;
      let tmpl: Template;
      try {
        tmpl = s.templates.get(name);
      } catch (e) {
        return respondError(404, errMessage(e));
      }
      const files: Obj[] = [];
      for (const action of tmpl.actions ?? []) {
        let path = action.path ?? "";
        if (vars) {
          path = replaceAll(path, vars, (k, v) => [
            [`{{snakeCase ${k}}}`, toSnakeCase(v)],
            [`{{kebabCase ${k}}}`, toKebabCase(v)],
            [`{{camelCase ${k}}}`, toCamelCase(v)],
            [`{{pascalCase ${k}}}`, toPascalCase(v)],
          ]);
        }
        if (tmpl.destination) path = joinPath(tmpl.destination, path);
        let skipped = false;
        let skipReason = "";
        if (action.skipIfExists && !dryRun) {
          try {
            statSync(join(s.store.projectRoot, path));
            skipped = true;
            skipReason = "file exists";
          } catch {
            // does not exist
          }
        }
        const f: Obj = { path, action: action.type };
        if (skipped) f.skipped = true;
        if (skipReason) f.skipReason = skipReason;
        files.push(f);
      }
      return jsonResponse(200, {
        dryRun,
        files,
        message: "Template executed successfully",
        success: true,
        template: name,
        variables: vars === undefined ? null : goMap(vars),
      });
    }),
  );
}

// ---- validate -----------------------------------------------------------------------------------

const roundPercent = (v: number): number => Math.round(v * 10) / 10;

function statusToCamelCase(s: string): string {
  let out = "";
  let upper = false;
  for (const ch of s) {
    if (ch === "-") {
      upper = true;
      continue;
    }
    if (upper) {
      out += ch >= "a" && ch <= "z" ? ch.toUpperCase() : ch;
      upper = false;
    } else out += ch;
  }
  return out;
}

export function registerValidate(r: Router, app: App): void {
  r.get(
    "/api/validate/sdd",
    requireStore(app, () => {
      const s = app.need();
      let tasks: import("../../models/task.ts").Task[];
      try {
        tasks = s.tasks.listAll();
        s.docs.list();
      } catch (e) {
        return respondError(500, errMessage(e));
      }
      let statuses: string[] = [];
      try {
        statuses = s.config.load().settings.statuses ?? [];
      } catch {
        statuses = [];
      }
      if (statuses.length === 0) {
        statuses = ["todo", "in-progress", "in-review", "done", "blocked", "on-hold", "urgent"];
      }
      const byStatus = new Map<string, number>();
      for (const st of statuses) byStatus.set(st, 0);
      const warnings: Obj[] = [];
      const passed: string[] = [];
      let withSpec = 0;
      let withoutSpec = 0;
      for (const t of tasks) {
        byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
        if (t.spec) withSpec++;
        else {
          withoutSpec++;
          warnings.push({
            type: "task-no-spec",
            entity: t.id,
            message: `Task "${t.title}" has no linked spec`,
          });
        }
      }
      const specPaths = new Set<string>();
      for (const t of tasks) if (t.spec) specPaths.add(t.spec);
      const coverage = tasks.length > 0 ? roundPercent((withSpec / tasks.length) * 100) : 0;
      const acCompletion: Record<string, Obj> = {};
      for (const t of tasks) {
        const crit = t.acceptanceCriteria ?? [];
        if (!t.spec || crit.length === 0) continue;
        const ac = acCompletion[t.spec] ?? { total: 0, completed: 0, percent: 0 };
        for (const cr of crit) {
          ac.total = (ac.total as number) + 1;
          if (cr.completed) ac.completed = (ac.completed as number) + 1;
        }
        const total = ac.total as number;
        if (total > 0) ac.percent = roundPercent(((ac.completed as number) / total) * 100);
        acCompletion[t.spec] = ac;
      }
      const decisionStats: Record<string, number> = {
        compliant: 0,
        unassessed: 0,
        conflicts: 0,
        impactDeclared: 0,
        impactInvalid: 0,
        legacyImpactMissing: 0,
      };
      const codes: Record<string, string> = {
        SDD_SPEC_DECISIONS_COMPLIANT: "compliant",
        SDD_SPEC_DECISIONS_UNASSESSED: "unassessed",
        SDD_SPEC_DECISION_CONFLICT: "conflicts",
        SDD_SYSTEM_DECISION_IMPACT_DECLARED: "impactDeclared",
        SDD_SYSTEM_DECISION_IMPACT_INVALID: "impactInvalid",
        SDD_LEGACY_SPEC_NO_SYSTEM_DECISION_IMPACT: "legacyImpactMissing",
      };
      const validation = runValidate(s, { scope: "sdd" });
      for (const issue of validation.issues) {
        const key = codes[issue.code];
        if (!key) continue;
        decisionStats[key] = (decisionStats[key] ?? 0) + 1;
        if (issue.level === "error" || issue.level === "warning") {
          warnings.push({ type: issue.code, entity: issue.entity ?? "", message: issue.message });
        } else passed.push(issue.message);
      }
      const taskStats: Obj = { total: tasks.length, withSpec, withoutSpec };
      for (const st of statuses) taskStats[statusToCamelCase(st)] = byStatus.get(st) ?? 0;
      const ac: Obj = {};
      for (const [k, v] of Object.entries(acCompletion)) ac[k] = goTop(v);
      return jsonResponse(200, {
        passed,
        stats: {
          acCompletion: goMap(ac),
          coverage: { linked: withSpec, percent: coverage, total: tasks.length },
          decisions: goMap(decisionStats),
          specs: { approved: 0, draft: 0, implemented: 0, total: specPaths.size },
          tasks: goTop(taskStats),
        },
        warnings,
      });
    }),
  );
}
