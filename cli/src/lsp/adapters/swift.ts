import type { Ctx } from "../context.ts";
import { commandOutput, refuseInstall, SpecAdapter } from "./helpers.ts";

export class SwiftAdapter extends SpecAdapter {
  constructor() {
    super({
      id: "swift",
      name: "Swift",
      // Only Swift: clangd's adapter already owns C/C++/ObjC, and an extension has one owner.
      extensions: [".swift"],
      // `--help`, not `--version`: sourcekit-lsp has no version flag (exits 64) and a failing
      // check makes the detector treat the binary as missing.
      binaries: [{ name: "sourcekit-lsp", check_args: ["--help"] }],
      prerequisites: [
        {
          name: "Swift toolchain",
          check_cmd: "swift --version",
          install_hint:
            "Install the Swift toolchain from https://swift.org/install, or Xcode on macOS",
        },
      ],
      installGuide: {
        command: "Install the Swift toolchain from https://swift.org/install",
        url: "https://swift.org/install",
        notes:
          "sourcekit-lsp ships inside the Swift toolchain and Xcode; it is never downloaded separately",
      },
      canInstall: false,
      defaultArgs: [],
      ignoredDirs: [".build", ".swiftpm", "DerivedData", "Pods"],
    });
  }
  /** Accepts a toolchain on PATH or, on macOS, one inside Xcode reachable through xcrun. */
  override async checkPrerequisites(ctx: Ctx): Promise<void> {
    try {
      await commandOutput(ctx, "swift", "--version");
      return;
    } catch {
      // fall through to xcrun
    }
    if (process.platform === "darwin") {
      try {
        await commandOutput(ctx, "xcrun", "--find", "sourcekit-lsp");
        return;
      } catch {
        // fall through
      }
    }
    throw new Error(
      `Swift toolchain prerequisite failed: install Swift from ${this.installGuide().url}`,
    );
  }
  install(_ctx: Ctx, _targetDir: string): Promise<string> {
    return refuseInstall(
      `swift adapter is not auto-installable; install the Swift toolchain from ${this.installGuide().url}`,
    );
  }
}

export function newSwiftAdapter(): SwiftAdapter {
  return new SwiftAdapter();
}
