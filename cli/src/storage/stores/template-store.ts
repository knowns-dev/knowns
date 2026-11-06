// Port of internal/storage/template_store.go: templates in .knowns/templates/ and
// .knowns/imports/*/templates/. A template is a folder with a `_template.yaml`.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  PromptChoice,
  Template,
  TemplateAction,
  TemplateMessages,
  TemplatePrompt,
} from "../../models/template.ts";
import { goFsMessage, goNotExistReason } from "../../platform/goerror.ts";
import { resolveSafe } from "../core/safe-path.ts";
import { atomicWrite } from "../core/util.ts";
import { asStr, parseYamlMap, readDirSorted } from "./internal.ts";

type Rec = Record<string, unknown>;

const asRec = (v: unknown): Rec =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {};
const asBool = (v: unknown): boolean => v === true || v === "true";

/** Copy the named string keys of `src` that are non-empty (yaml omitempty). */
function strings<K extends string>(src: Rec, keys: readonly K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const k of keys) {
    const v = asStr(src[k]);
    if (v !== "") out[k] = v;
  }
  return out;
}

function list<T>(v: unknown, map: (r: Rec) => T): T[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error("expected a list");
  return v.length === 0 ? undefined : v.map((x) => map(asRec(x)));
}

function parsePrompt(r: Rec): TemplatePrompt {
  const p: TemplatePrompt = {
    name: asStr(r.name),
    type: asStr(r.type),
    message: asStr(r.message),
    ...strings(r, ["validate", "initial", "hint", "when"] as const),
  };
  const choices = list<PromptChoice>(r.choices, (c) => {
    const choice: PromptChoice = {
      title: asStr(c.title),
      value: asStr(c.value),
      ...strings(c, ["description"] as const),
    };
    if (asBool(c.selected)) choice.selected = true;
    return choice;
  });
  if (choices) p.choices = choices;
  return p;
}

function parseAction(r: Rec): TemplateAction {
  const a: TemplateAction = {
    type: asStr(r.type),
    ...strings(r, [
      "template",
      "path",
      "when",
      "source",
      "destination",
      "globPattern",
      "pattern",
      "separator",
    ] as const),
  };
  if (asBool(r.skipIfExists)) a.skipIfExists = true;
  if (asBool(r.unique)) a.unique = true;
  return a;
}

/** parseTemplate: the Template described by a `_template.yaml` text (a leading `# ` line is a comment). */
export function parseTemplateYaml(text: string, dirName: string): Template {
  let raw = text;
  const nl = raw.indexOf("\n");
  if (raw.startsWith("# ")) raw = nl === -1 ? "" : raw.slice(nl + 1);
  const y = parseYamlMap(raw);
  const t: Template = {
    name: asStr(y.name) || dirName,
    ...strings(y, ["description", "version", "author", "destination", "doc"] as const),
  };
  const prompts = list(y.prompts, parsePrompt);
  if (prompts) t.prompts = prompts;
  const actions = list(y.actions, parseAction);
  if (actions) t.actions = actions;
  if (y.messages !== undefined && y.messages !== null) {
    const m = asRec(y.messages);
    t.messages = strings(m, ["success", "failure"] as const) as TemplateMessages;
  }
  return t;
}

export class TemplateStore {
  readonly root: string;
  constructor(store: { root: string }) {
    this.root = store.root;
  }

  templatesDir(): string {
    return join(this.root, "templates");
  }
  importsDir(): string {
    return join(this.root, "imports");
  }

  /** List: local templates, then imported ones. */
  list(): Template[] {
    const templates = this.listDir(this.templatesDir(), false, "");
    for (const e of readDirSorted(this.importsDir())) {
      if (!e.isDirectory()) continue;
      templates.push(...this.listDir(join(this.importsDir(), e.name, "templates"), true, e.name));
    }
    return templates;
  }

  private listDir(dir: string, imported: boolean, importName: string): Template[] {
    const out: Template[] = [];
    for (const e of readDirSorted(dir)) {
      if (!e.isDirectory()) continue;
      const templateDir = join(dir, e.name);
      if (!existsSync(join(templateDir, "_template.yaml"))) continue;
      try {
        out.push(this.parseTemplate(e.name, templateDir, imported, importName));
      } catch {
        // skip unreadable
      }
    }
    return out;
  }

  /** Get: by name; `import/name` addresses an imported template. */
  get(name: string): Template {
    const slash = name.indexOf("/");
    if (slash !== -1) {
      const importName = name.slice(0, slash);
      const templateName = name.slice(slash + 1);
      let templateDir: string;
      try {
        const importDir = resolveSafe(this.importsDir(), importName);
        templateDir = resolveSafe(join(importDir, "templates"), templateName);
      } catch (e) {
        throw new Error(`invalid import template name: ${(e as Error).message}`);
      }
      return this.parseTemplate(templateName, templateDir, true, importName);
    }
    let templateDir: string;
    try {
      templateDir = resolveSafe(this.templatesDir(), name);
    } catch (e) {
      throw new Error(`invalid template name: ${(e as Error).message}`);
    }
    return this.parseTemplate(name, templateDir, false, "");
  }

  private parseTemplate(
    name: string,
    dir: string,
    imported: boolean,
    importName: string,
  ): Template {
    let data: string;
    try {
      data = readFileSync(join(dir, "_template.yaml"), "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const file = join(dir, "_template.yaml");
      // Go: "open <path>: <reason>"; on Windows the reason depends on whether the folder exists.
      if (code === "ENOENT") {
        throw new Error(
          `read template ${name}: open ${file}: ${goNotExistReason(existsSync(dir))}`,
        );
      }
      throw new Error(`read template ${name}: ${goFsMessage(e)}`);
    }
    let t: Template;
    try {
      t = parseTemplateYaml(data, name);
    } catch (e) {
      throw new Error(`parse template ${name}: ${(e as Error).message}`);
    }
    t.path = dir;
    if (imported) {
      t.imported = true;
      if (importName !== "") t.importName = importName;
    }
    return t;
  }

  /** Create: scaffold a template folder with a `_template.yaml` and a starter `main.hbs`. */
  create(name: string, description: string): void {
    let templateDir: string;
    try {
      templateDir = resolveSafe(this.templatesDir(), name);
    } catch (e) {
      throw new Error(`invalid template name: ${(e as Error).message}`);
    }
    mkdirSync(templateDir, { recursive: true, mode: 0o755 });
    const configPath = join(templateDir, "_template.yaml");
    if (existsSync(configPath)) throw new Error(`template "${name}" already exists`);
    const config = `# Template: ${name}
name: ${name}
description: ${description}
version: 1.0.0

# Link to documentation (optional)
doc: ""

# Base destination path relative to project root
destination: src

# Interactive prompts
prompts:
  - name: name
    type: text
    message: "Name?"
    validate: required

# File generation actions
actions:
  - type: add
    template: "main.hbs"
    path: "{{kebabCase name}}.ts"
    skipIfExists: true

# Success/failure messages
messages:
  success: |
    Created: {{name}}
`;
    atomicWrite(configPath, config);
    atomicWrite(
      join(templateDir, "main.hbs"),
      `// Generated: {{name}}\n// Created by Knowns template: ${name}\n`,
    );
  }
}
