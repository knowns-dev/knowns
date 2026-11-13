import { goLookPathError } from "../../platform/goerror.ts";
import type { Ctx } from "../context.ts";
import { lookPath, runProcess } from "../exec.ts";
import { commandOutput, SpecAdapter } from "./helpers.ts";

export class RustAnalyzerAdapter extends SpecAdapter {
  constructor() {
    super({
      id: "rust",
      name: "Rust",
      extensions: [".rs"],
      binaries: [{ name: "rust-analyzer", check_args: ["--version"] }],
      prerequisites: [
        {
          name: "rustup",
          check_cmd: "rustup --version",
          install_hint: "Install Rust via https://rustup.rs/",
        },
      ],
      installGuide: {
        command: "rustup component add rust-analyzer",
        knowns_cmd: "knowns lsp install rust",
        url: "https://rust-analyzer.github.io/",
        notes: "Requires rustup installed",
      },
      canInstall: true,
      defaultArgs: [],
      ignoredDirs: ["target"],
    });
  }
  override async checkPrerequisites(ctx: Ctx): Promise<void> {
    await commandOutput(ctx, "rustup", "--version");
  }
  async install(ctx: Ctx, _targetDir: string): Promise<string> {
    const r = await runProcess(ctx, "rustup", ["component", "add", "rust-analyzer"]);
    if (r.code !== 0) {
      throw new Error(`rustup install failed: exit status ${r.code}: ${r.stdout + r.stderr}`);
    }
    const path = lookPath("rust-analyzer");
    if (path === undefined) {
      throw new Error(
        `rust-analyzer installed but not found in PATH: ${goLookPathError("rust-analyzer")}`,
      );
    }
    return path;
  }
}

export function newRustAnalyzerAdapter(): RustAnalyzerAdapter {
  return new RustAnalyzerAdapter();
}
