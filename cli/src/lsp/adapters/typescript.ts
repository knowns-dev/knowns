import type { Ctx } from "../context.ts";
import type { DocumentSyncOptions, RuntimeDependency } from "../types.ts";
import { commandOutput, installManaged, requireMinVersion, SpecAdapter } from "./helpers.ts";

export class TypeScriptAdapter extends SpecAdapter {
  constructor() {
    super({
      id: "typescript",
      name: "TypeScript",
      extensions: [".ts", ".tsx", ".js", ".jsx"],
      binaries: [
        { name: "typescript-language-server", args: ["--stdio"], check_args: ["--version"] },
      ],
      prerequisites: [
        {
          name: "Node.js 18+",
          check_cmd: "node --version",
          install_hint: "Install Node.js 18+ from https://nodejs.org/",
        },
      ],
      installGuide: {
        command: "npm install -g typescript-language-server typescript",
        knowns_cmd: "knowns lsp install typescript",
        notes: "Requires Node.js 18+ installed",
      },
      canInstall: true,
      defaultArgs: ["--stdio"],
      ignoredDirs: ["node_modules", "dist", "build", ".next"],
    });
  }
  override async checkPrerequisites(ctx: Ctx): Promise<void> {
    requireMinVersion(await commandOutput(ctx, "node", "--version"), "Node.js", 18, 0);
  }
  override runtimeDeps(): RuntimeDependency[] {
    return [
      {
        id: "typescript-language-server",
        version: "latest",
        source: "npm",
        archive_type: "npm",
        binary_name: "typescript-language-server",
        package_name: "typescript-language-server",
        packages: ["typescript-language-server", "typescript"],
      },
    ];
  }
  install(ctx: Ctx, targetDir: string): Promise<string> {
    return installManaged(this, ctx, targetDir);
  }

  /**
   * Sends the language identifier tsserver expects for each file. One registry ID serves four
   * extensions and tsserver picks the script kind from languageId, not the file name.
   */
  documentSyncForPath(path: string): DocumentSyncOptions {
    return { languageID: typeScriptLanguageID(path), suppress: false };
  }
}

export function typeScriptLanguageID(path: string): string {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  if (normalized.endsWith(".tsx")) return "typescriptreact";
  if (normalized.endsWith(".jsx")) return "javascriptreact";
  if (normalized.endsWith(".js")) return "javascript";
  return "typescript";
}

export function newTypeScriptAdapter(): TypeScriptAdapter {
  return new TypeScriptAdapter();
}
