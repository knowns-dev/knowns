import type { Ctx } from "../context.ts";
import type { RuntimeDependency } from "../types.ts";
import { commandOutput, installManaged, requireMinVersion, SpecAdapter } from "./helpers.ts";

export class IntelephenseAdapter extends SpecAdapter {
  constructor() {
    super({
      id: "php",
      name: "PHP",
      extensions: [".php"],
      binaries: [{ name: "intelephense", args: ["--stdio"], check_args: ["--version"] }],
      prerequisites: [
        {
          name: "Node.js 18+",
          check_cmd: "node --version",
          install_hint: "Install Node.js 18+ from https://nodejs.org/",
        },
      ],
      installGuide: {
        command: "npm install -g intelephense",
        knowns_cmd: "knowns lsp install php",
        url: "https://intelephense.com/",
        notes: "Requires Node.js 18+",
      },
      canInstall: true,
      defaultArgs: ["--stdio"],
      ignoredDirs: ["vendor", "node_modules", "storage", "bootstrap/cache"],
    });
  }
  override async checkPrerequisites(ctx: Ctx): Promise<void> {
    requireMinVersion(await commandOutput(ctx, "node", "--version"), "Node.js", 18, 0);
  }
  override runtimeDeps(): RuntimeDependency[] {
    return [
      {
        id: "intelephense",
        version: "latest",
        source: "npm",
        archive_type: "npm",
        binary_name: "intelephense",
        package_name: "intelephense",
      },
    ];
  }
  install(ctx: Ctx, targetDir: string): Promise<string> {
    return installManaged(this, ctx, targetDir);
  }
}

export function newIntelephenseAdapter(): IntelephenseAdapter {
  return new IntelephenseAdapter();
}
