import type { Ctx } from "../context.ts";
import { commandOutput, quote, refuseInstall, requireMinVersion, SpecAdapter } from "./helpers.ts";

export class GoAdapter extends SpecAdapter {
  constructor() {
    super({
      id: "go",
      name: "Go",
      extensions: [".go"],
      binaries: [{ name: "gopls", args: ["serve"], check_args: ["version"] }],
      prerequisites: [
        {
          name: "Go 1.21+",
          check_cmd: "go version",
          install_hint: "Install Go from https://go.dev/dl/",
        },
      ],
      installGuide: {
        command: "go install golang.org/x/tools/gopls@latest",
        url: "https://pkg.go.dev/golang.org/x/tools/gopls",
        notes: "Requires Go 1.21+ installed",
      },
      canInstall: false,
      defaultArgs: ["serve"],
      ignoredDirs: ["vendor", "node_modules", "dist", "build"],
    });
  }
  override async checkPrerequisites(ctx: Ctx): Promise<void> {
    requireMinVersion(await commandOutput(ctx, "go", "version"), "Go", 1, 21);
  }
  install(_ctx: Ctx, _targetDir: string): Promise<string> {
    return refuseInstall(
      `go adapter is not auto-installable; run ${quote(this.installGuide().command ?? "")}`,
    );
  }
}

export function newGoAdapter(): GoAdapter {
  return new GoAdapter();
}
