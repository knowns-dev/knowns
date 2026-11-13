import type { Ctx } from "../context.ts";
import type { RuntimeDependency } from "../types.ts";
import { installManaged, SpecAdapter } from "./helpers.ts";

export class ClangdAdapter extends SpecAdapter {
  constructor() {
    super({
      id: "c_cpp",
      name: "C/C++",
      extensions: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx"],
      binaries: [{ name: "clangd", check_args: ["--version"] }],
      prerequisites: [],
      installGuide: {
        knowns_cmd: "knowns lsp install c_cpp",
        url: "https://clangd.llvm.org/installation",
        notes: "Standalone clangd binaries can be installed by Knowns for supported platforms",
      },
      canInstall: true,
      defaultArgs: [],
      ignoredDirs: ["build", "cmake-build-debug", "cmake-build-release", ".cache"],
    });
  }
  override runtimeDeps(): RuntimeDependency[] {
    // TODO (kept from Go): update SHA-256 values for the pinned clangd release assets.
    const mk = (platform_id: string, asset: string): RuntimeDependency => ({
      id: "18.1.3",
      platform_id,
      url: `https://github.com/clangd/clangd/releases/download/18.1.3/${asset}`,
      sha256: "TODO",
      archive_type: "zip",
      binary_name: "clangd",
      extract_path: "clangd_18.1.3/bin",
    });
    return [
      mk("darwin-arm64", "clangd-mac-18.1.3.zip"),
      mk("darwin-amd64", "clangd-mac-18.1.3.zip"),
      mk("linux-amd64", "clangd-linux-18.1.3.zip"),
      mk("linux-arm64", "clangd-linux-18.1.3.zip"),
      mk("windows-amd64", "clangd-windows-18.1.3.zip"),
    ];
  }
  install(ctx: Ctx, targetDir: string): Promise<string> {
    return installManaged(this, ctx, targetDir, "install clangd");
  }
}

export function newClangdAdapter(): ClangdAdapter {
  return new ClangdAdapter();
}
