import { documentConfigCapabilityProfile } from "../capabilities.ts";
import type { Ctx } from "../context.ts";
import type { CapabilityProfile, PathMatcher, RuntimeDependency } from "../types.ts";
import { checkBinary, installManaged, SpecAdapter } from "./helpers.ts";

export const jsonLanguageServerVersion = "1.3.4";
export const jsonLanguageServerIntegrity =
  "sha512-+ghebnslXk6fVDySBrT0BVqozLDdmKY/qxgkDD4JtOQcU2vXc3e7jh7YyMxvuvE93E9OLvBqUrvajttj8xf3BA==";
export const jsonPathPriority = 100;
export const jsonDetectionBanPriority = 200;

/** JSON and JSONC intelligence through the VS Code JSON language server. */
export class JSONAdapter extends SpecAdapter {
  constructor() {
    super({
      id: "json",
      name: "JSON/JSONC",
      extensions: [".json", ".jsonc"],
      binaries: [{ name: "vscode-json-languageserver", args: ["--stdio"] }],
      prerequisites: [
        {
          name: "Node.js",
          check_cmd: "node --version",
          install_hint: "Install Node.js from https://nodejs.org/",
        },
      ],
      installGuide: {
        command: `npm install -g vscode-json-languageserver@${jsonLanguageServerVersion}`,
        knowns_cmd: "knowns lsp install json",
        url: "https://www.npmjs.com/package/vscode-json-languageserver",
        notes: "Requires Node.js; Knowns installs the recommended integrity-pinned version",
      },
      canInstall: true,
      defaultArgs: ["--stdio"],
      ignoredDirs: ["node_modules", "dist", "build"],
    });
  }
  override checkPrerequisites(ctx: Ctx): Promise<void> {
    return checkBinary(ctx, "node", "--version");
  }
  override runtimeDeps(): RuntimeDependency[] {
    return [
      {
        id: "vscode-json-languageserver",
        version: jsonLanguageServerVersion,
        recommended_version: jsonLanguageServerVersion,
        recommended_integrity: jsonLanguageServerIntegrity,
        source: "npm",
        archive_type: "npm",
        binary_name: "vscode-json-languageserver",
        package_name: "vscode-json-languageserver",
        packages: ["vscode-json-languageserver"],
      },
    ];
  }
  install(ctx: Ctx, targetDir: string): Promise<string> {
    return installManaged(this, ctx, targetDir);
  }
  /**
   * Keeps generic JSON routing below Terraform's compound suffix matchers. Lockfiles and generated
   * JSON stay explicitly addressable while being excluded from repository auto-detection.
   */
  pathMatchers(): PathMatcher[] {
    return [
      {
        kind: "exact_name",
        pattern: "package-lock.json",
        priority: jsonDetectionBanPriority,
        explicitOnly: true,
      },
      {
        kind: "exact_name",
        pattern: "npm-shrinkwrap.json",
        priority: jsonDetectionBanPriority,
        explicitOnly: true,
      },
      {
        kind: "suffix",
        pattern: ".generated.json",
        priority: jsonDetectionBanPriority,
        explicitOnly: true,
      },
      { kind: "suffix", pattern: ".jsonc", priority: jsonPathPriority },
      { kind: "suffix", pattern: ".json", priority: jsonPathPriority },
    ];
  }
  lazyStart(): boolean {
    return true;
  }
  capabilityProfile(): CapabilityProfile {
    return documentConfigCapabilityProfile();
  }
  override supportsImplementation(): boolean {
    return false;
  }
  override supportsReferences(): boolean {
    return false;
  }
}

export function newJSONAdapter(): JSONAdapter {
  return new JSONAdapter();
}
