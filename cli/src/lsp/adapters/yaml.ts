import { documentConfigCapabilityProfile } from "../capabilities.ts";
import type { Ctx } from "../context.ts";
import type { CapabilityProfile, PathMatcher, RuntimeDependency } from "../types.ts";
import { commandOutput, installManaged, requireMinVersion, SpecAdapter } from "./helpers.ts";

export const yamlLanguageServerVersion = "1.24.0";
export const yamlLanguageServerIntegrity =
  "sha512-+HGcwu4M7IC+UDhDZScTZR8qsl2MMj/X1E5e83QcWzWn2pctj0fv8HHdrHHcbc1KB3CuRPJ4gc1Nm36D0iCu0g==";
export const yamlPathPriority = 100;

/** YAML document intelligence through yaml-language-server. */
export class YAMLAdapter extends SpecAdapter {
  constructor() {
    super({
      id: "yaml",
      name: "YAML",
      extensions: [".yaml", ".yml"],
      binaries: [{ name: "yaml-language-server", args: ["--stdio"] }],
      prerequisites: [
        {
          name: "Node.js 12+",
          check_cmd: "node --version",
          install_hint: "Install Node.js 12+ from https://nodejs.org/",
        },
      ],
      installGuide: {
        command: `npm install -g yaml-language-server@${yamlLanguageServerVersion}`,
        knowns_cmd: "knowns lsp install yaml",
        url: "https://github.com/redhat-developer/yaml-language-server",
        notes: "Requires Node.js 12+; Knowns installs the recommended integrity-pinned version",
      },
      canInstall: true,
      defaultArgs: ["--stdio"],
      ignoredDirs: ["build", "dist", "generated", "node_modules", "testdata", "vendor"],
    });
  }
  pathMatchers(): PathMatcher[] {
    return [
      { kind: "suffix", pattern: ".yaml", priority: yamlPathPriority },
      { kind: "suffix", pattern: ".yml", priority: yamlPathPriority },
    ];
  }
  lazyStart(): boolean {
    return true;
  }
  capabilityProfile(): CapabilityProfile {
    return documentConfigCapabilityProfile();
  }
  override async checkPrerequisites(ctx: Ctx): Promise<void> {
    requireMinVersion(await commandOutput(ctx, "node", "--version"), "Node.js", 12, 0);
  }
  override runtimeDeps(): RuntimeDependency[] {
    return [
      {
        id: "yaml-language-server",
        version: yamlLanguageServerVersion,
        recommended_version: yamlLanguageServerVersion,
        recommended_integrity: yamlLanguageServerIntegrity,
        source: "npm",
        archive_type: "npm",
        binary_name: "yaml-language-server",
        package_name: "yaml-language-server",
        packages: ["yaml-language-server"],
      },
    ];
  }
  install(ctx: Ctx, targetDir: string): Promise<string> {
    return installManaged(this, ctx, targetDir);
  }
  override supportsImplementation(): boolean {
    return false;
  }
  override supportsReferences(): boolean {
    return false;
  }
}

export function newYAMLAdapter(): YAMLAdapter {
  return new YAMLAdapter();
}
