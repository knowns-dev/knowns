import type { Ctx } from "../context.ts";
import { DartLanguageID } from "../types.ts";
import { commandOutput, refuseInstall, SpecAdapter } from "./helpers.ts";

export class DartAdapter extends SpecAdapter {
  constructor() {
    super({
      id: DartLanguageID,
      name: "Dart",
      extensions: [".dart"],
      binaries: [{ name: "dart", args: ["language-server"], check_args: ["--version"] }],
      prerequisites: [
        {
          name: "Dart SDK",
          check_cmd: "dart --version",
          install_hint: "Install Dart SDK from https://dart.dev/get-dart",
        },
      ],
      installGuide: {
        command: "Install Dart SDK from https://dart.dev/get-dart",
        url: "https://dart.dev/get-dart",
        notes: "Dart language server is bundled with the Dart SDK",
      },
      canInstall: false,
      defaultArgs: ["language-server"],
      ignoredDirs: ["build", ".dart_tool", ".pub", ".packages"],
    });
  }
  override async checkPrerequisites(ctx: Ctx): Promise<void> {
    await commandOutput(ctx, "dart", "--version");
  }
  install(_ctx: Ctx, _targetDir: string): Promise<string> {
    return refuseInstall(
      `dart adapter is not auto-installable; install the Dart SDK from ${this.installGuide().url}`,
    );
  }
}

export function newDartAdapter(): DartAdapter {
  return new DartAdapter();
}
