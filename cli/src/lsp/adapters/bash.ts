import { codeCapabilityProfile } from "../capabilities.ts";
import type { Ctx } from "../context.ts";
import type { CapabilityProfile, PathMatcher, RuntimeDependency } from "../types.ts";
import {
  commandOutput,
  initializationOptions,
  initializeParams,
  installManaged,
  requireMinVersion,
  SpecAdapter,
} from "./helpers.ts";

export const bashLanguageServerVersion = "5.6.0";
export const bashLanguageServerIntegrity =
  "sha512-DCuV+/BZAAozsp5blvi6jDnU/ZDaTpJpWM0zqwGjnirfqv7iBsMK32xOze/jipxU0PUZ6CBUKgRUMKI7Kk70Lg==";

/** BashAdapter configures bash-language-server for Bash and POSIX shell files. */
export class BashAdapter extends SpecAdapter {
  constructor() {
    super({
      id: "bash",
      name: "Bash",
      extensions: [".sh", ".bash"],
      binaries: [{ name: "bash-language-server", args: ["start"], check_args: ["--version"] }],
      prerequisites: [
        {
          name: "Node.js 20+",
          check_cmd: "node --version",
          install_hint: "Install Node.js 20+ from https://nodejs.org/",
        },
      ],
      installGuide: {
        command: `npm install -g bash-language-server@${bashLanguageServerVersion}`,
        url: "https://github.com/bash-lsp/bash-language-server",
        knowns_cmd: "knowns lsp install bash",
        notes: "Requires Node.js 20+; Knowns uses the pinned recommended version by default",
      },
      canInstall: true,
      defaultArgs: ["start"],
      ignoredDirs: [".git", "dist", "generated", "node_modules", "vendor"],
    });
  }
  pathMatchers(): PathMatcher[] {
    return [
      { kind: "suffix", pattern: ".bash", priority: 220 },
      { kind: "suffix", pattern: ".sh", priority: 210 },
      { kind: "shebang", pattern: "bash", priority: 120 },
      { kind: "shebang", pattern: "sh", priority: 110 },
    ];
  }
  lazyStart(): boolean {
    return true;
  }
  capabilityProfile(): CapabilityProfile {
    return codeCapabilityProfile();
  }
  override async checkPrerequisites(ctx: Ctx): Promise<void> {
    requireMinVersion(await commandOutput(ctx, "node", "--version"), "Node.js", 20, 0);
  }
  override runtimeDeps(): RuntimeDependency[] {
    return [
      {
        id: "bash-language-server",
        version: bashLanguageServerVersion,
        recommended_version: bashLanguageServerVersion,
        recommended_integrity: bashLanguageServerIntegrity,
        source: "npm",
        archive_type: "npm",
        binary_name: "bash-language-server",
        package_name: "bash-language-server",
        packages: ["bash-language-server"],
      },
    ];
  }
  install(ctx: Ctx, targetDir: string): Promise<string> {
    return installManaged(this, ctx, targetDir);
  }
  override initializeParams(root: string, settings: Record<string, unknown> | undefined) {
    return bashInitializeParams(
      root,
      settings,
      process.platform === "win32" ? "windows" : process.platform,
    );
  }
}

/**
 * bash-language-server 5.6.0 cannot resolve relative sourced files from a file URI on Windows;
 * its rootPath fallback accepts the native path and keeps cross-file navigation working.
 */
export function bashInitializeParams(
  root: string,
  settings: Record<string, unknown> | undefined,
  goos: string,
): Record<string, unknown> {
  if (goos === "windows") {
    return { rootPath: root, initializationOptions: initializationOptions(settings) };
  }
  return initializeParams(root, settings);
}

export function newBashAdapter(): BashAdapter {
  return new BashAdapter();
}
