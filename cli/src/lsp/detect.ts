// Port of internal/lsp/detect.go.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { selectBinaryOverride } from "./binary-override.ts";
import type { Config } from "./config.ts";
import { type Ctx, withTimeout } from "./context.ts";
import { discoverCSharpProject, resolveCSharpBackendWithOptions } from "./csharp.ts";
import { defaultLSPBaseDir } from "./dependency-adapter.ts";
import {
  lookPath as defaultLookPath,
  defaultRunCommand,
  type LookPath,
  type RunCheck,
  type RunCommand,
  runVersionCheck,
} from "./exec.ts";
import { Installer } from "./installer.ts";
import { Registry } from "./registry.ts";
import { type Binary, CSharpLanguageID, type Language, type ServerCommand } from "./types.ts";

const autoDetectionIgnoredDirs = new Set([
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

export function isAutoDetectionIgnoredDir(name: string): boolean {
  return autoDetectionIgnoredDirs.has(name.trim().toLowerCase());
}

/** LanguageLogPath: the shared wrapper log path for non-backend-specific language servers. */
export function languageLogPath(root: string, languageID: string): string {
  if (root === "" || languageID === "") return "";
  return join(root, ".knowns", "logs", "lsp", `${languageID}.log`);
}

export class Detector {
  registry: Registry;
  lookPath: LookPath;
  runCheck: RunCheck | undefined;
  runCommand: RunCommand | undefined;
  installer: Installer | undefined;

  constructor(registry?: Registry | null) {
    this.registry = registry ?? new Registry();
    this.lookPath = defaultLookPath;
    this.runCheck = runVersionCheck;
    this.runCommand = defaultRunCommand;
    this.installer = new Installer(defaultLSPBaseDir());
  }

  async detect(ctx: Ctx, root: string, cfg: Config): Promise<ServerCommand[]> {
    const languages = this.detectedLanguages(root, cfg);
    const commands: ServerCommand[] = [];
    for (const lang of languages) {
      if (lang.id === CSharpLanguageID && cfg.binaryOverride(lang.id) === "") {
        const [cmd, ok] = await resolveCSharpBackendWithOptions(ctx, root, cfg, {
          lookPath: this.lookPath,
          runCheck: this.runCheck,
          runCommand: this.runCommand,
          installer: this.installer,
        });
        if (ok) commands.push(cmd);
        continue;
      }
      const cmd = await this.resolve(ctx, root, lang, cfg.binaryOverride(lang.id));
      if (cmd) {
        if (lang.id === CSharpLanguageID) {
          cmd.backend = cfg.backendOverride(lang.id) || "custom";
          cmd.projectPath = discoverCSharpProject(root, cfg.projectPathOverride(lang.id)).path;
        }
        commands.push(cmd);
      }
    }
    return commands;
  }

  /** DetectedLanguages: enabled languages with matching project files. */
  detectedLanguages(root: string, cfg: Config): Language[] {
    const seen = new Set<string>();
    const walk = (dir: string): void => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (isAutoDetectionIgnoredDir(entry.name)) continue;
          walk(full);
          continue;
        }
        const lang = this.registry.forDetection(full);
        if (lang) seen.add(lang.id);
      }
    };
    walk(root);
    return this.registry.languages().filter((l) => seen.has(l.id) && cfg.enabled(l.id));
  }

  /** resolve returns the first usable binary of lang, or undefined. */
  async resolve(
    ctx: Ctx,
    root: string,
    lang: Language,
    override: string,
  ): Promise<ServerCommand | undefined> {
    let binaries: Binary[] = lang.binaries ?? [];
    if (override !== "") {
      try {
        binaries = [selectBinaryOverride(override, binaries)];
      } catch {
        return undefined;
      }
    }
    for (const binary of binaries) {
      const path = this.lookPath(binary.name);
      if (path === undefined) continue;
      if (this.runCheck && binary.checkArgs && binary.checkArgs.length > 0) {
        const t = withTimeout(ctx, 2000);
        try {
          await this.runCheck(t.ctx, path, ...binary.checkArgs);
        } catch {
          continue;
        } finally {
          t.cancel();
        }
      }
      return {
        language: lang.id,
        name: binary.name,
        path,
        args: [...(binary.args ?? [])],
        logPath: languageLogPath(root, lang.id),
      };
    }
    return undefined;
  }
}
