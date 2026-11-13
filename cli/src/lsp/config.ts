// Port of internal/lsp/config.go.
import type { Project } from "../models/index.ts";

export interface LanguageConfig {
  enabled?: boolean;
  binary?: string;
  version?: string;
  backend?: string;
  projectPath?: string;
  settings?: Record<string, unknown>;
}

function cloneSettings(
  s: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return s ? { ...s } : undefined;
}

function cloneLanguage(lc: LanguageConfig): LanguageConfig {
  const out: LanguageConfig = { ...lc };
  if (lc.settings) out.settings = cloneSettings(lc.settings);
  return out;
}

/** Config is the per-language LSP configuration (Go lsp.Config). */
export class Config {
  readonly languages: Record<string, LanguageConfig>;

  constructor(languages: Record<string, LanguageConfig> = {}) {
    this.languages = languages;
  }

  static fromSettings(settings: { lsp?: LspSettingsLike } | undefined): Config {
    const lsp = settings?.lsp;
    if (!lsp) return new Config();
    const languages: Record<string, LanguageConfig> = {};
    for (const [name, entry] of Object.entries(lsp.languages ?? {})) {
      const lc: LanguageConfig = {};
      if (entry.enabled !== undefined) lc.enabled = entry.enabled;
      if (entry.binary) lc.binary = entry.binary;
      if (entry.version) lc.version = entry.version;
      if (entry.backend) lc.backend = entry.backend;
      if (entry.projectPath) lc.projectPath = entry.projectPath;
      if (entry.settings) lc.settings = { ...entry.settings };
      languages[name] = lc;
    }
    return new Config(languages);
  }

  /** ConfigFromProjectWithDefaults: global defaults first, project settings merged over them. */
  static fromProject(
    project: Pick<Project, "settings"> | undefined | null,
    defaults?: { settings?: unknown } | undefined | null,
  ): Config {
    let cfg = new Config();
    if (defaults?.settings)
      cfg = Config.fromSettings(defaults.settings as { lsp?: LspSettingsLike });
    if (!project?.settings?.lsp) return cfg;
    return cfg.merge(Config.fromSettings(project.settings as { lsp?: LspSettingsLike }));
  }

  merge(override: Config): Config {
    const a = Object.keys(this.languages).length;
    const b = Object.keys(override.languages).length;
    if (a === 0 && b === 0) return new Config();
    const merged: Record<string, LanguageConfig> = {};
    for (const [lang, entry] of Object.entries(this.languages)) merged[lang] = cloneLanguage(entry);
    for (const [lang, entry] of Object.entries(override.languages)) {
      const base: LanguageConfig = merged[lang] ?? {};
      if (entry.enabled !== undefined) base.enabled = entry.enabled;
      if (entry.binary) base.binary = entry.binary;
      if (entry.version) base.version = entry.version;
      if (entry.backend) base.backend = entry.backend;
      if (entry.projectPath) base.projectPath = entry.projectPath;
      if (entry.settings && Object.keys(entry.settings).length > 0) {
        base.settings = { ...(base.settings ?? {}), ...entry.settings };
      }
      merged[lang] = base;
    }
    return new Config(merged);
  }

  clone(): Config {
    const out: Record<string, LanguageConfig> = {};
    for (const [k, v] of Object.entries(this.languages)) out[k] = cloneLanguage(v);
    return new Config(out);
  }

  enabled(language: string): boolean {
    const entry = this.languages[language];
    if (!entry || entry.enabled === undefined) return true;
    return entry.enabled;
  }
  binaryOverride(language: string): string {
    return this.languages[language]?.binary ?? "";
  }
  versionOverride(language: string): string {
    return this.languages[language]?.version ?? "";
  }
  backendOverride(language: string): string {
    return this.languages[language]?.backend ?? "";
  }
  projectPathOverride(language: string): string {
    return this.languages[language]?.projectPath ?? "";
  }
  languageSettings(language: string): Record<string, unknown> | undefined {
    return this.languages[language]?.settings;
  }
  isDisabled(language: string): boolean {
    const entry = this.languages[language];
    if (!entry || entry.enabled === undefined) return false;
    return !entry.enabled;
  }
}

interface LspSettingsLike {
  enabled?: boolean;
  languages?: Record<
    string,
    {
      enabled?: boolean;
      binary?: string;
      version?: string;
      backend?: string;
      projectPath?: string;
      settings?: Record<string, unknown>;
    }
  >;
}
