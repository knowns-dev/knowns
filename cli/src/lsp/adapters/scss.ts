import type { Ctx } from "../context.ts";
import type { RuntimeDependency } from "../types.ts";
import { commandOutput, installManaged, requireMinVersion, SpecAdapter } from "./helpers.ts";

export class ScssAdapter extends SpecAdapter {
  constructor() {
    super({
      id: "scss",
      name: "SCSS/Sass/CSS",
      extensions: [".scss", ".sass", ".css"],
      binaries: [
        { name: "some-sass-language-server", args: ["--stdio"], check_args: ["--version"] },
      ],
      prerequisites: [
        {
          name: "Node.js 18+",
          check_cmd: "node --version",
          install_hint: "Install Node.js 18+ from https://nodejs.org/",
        },
      ],
      installGuide: {
        command: "npm install -g some-sass-language-server",
        knowns_cmd: "knowns lsp install scss",
        notes: "Requires Node.js 18+; handles .scss, .sass, and .css files",
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
        id: "some-sass-language-server",
        version: "latest",
        source: "npm",
        archive_type: "npm",
        binary_name: "some-sass-language-server",
        package_name: "some-sass-language-server",
      },
    ];
  }
  install(ctx: Ctx, targetDir: string): Promise<string> {
    return installManaged(this, ctx, targetDir);
  }
}

export function newScssAdapter(): ScssAdapter {
  return new ScssAdapter();
}
