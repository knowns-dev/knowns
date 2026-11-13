import { goLookPathError } from "../../platform/goerror.ts";
import type { Ctx } from "../context.ts";
import { lookPath, runProcess } from "../exec.ts";
import { commandOutput, requireMinVersion, SpecAdapter } from "./helpers.ts";

export class RubyLspAdapter extends SpecAdapter {
  constructor() {
    super({
      id: "ruby",
      name: "Ruby",
      extensions: [".rb", ".rake", ".gemspec"],
      binaries: [{ name: "ruby-lsp", check_args: ["--version"] }],
      prerequisites: [
        {
          name: "Ruby 3.1+",
          check_cmd: "ruby --version",
          install_hint: "Install Ruby 3.1+ from https://www.ruby-lang.org/en/downloads/",
        },
      ],
      installGuide: {
        command: "gem install ruby-lsp",
        url: "https://github.com/Shopify/ruby-lsp",
        notes: "Requires Ruby 3.1+",
      },
      canInstall: true,
      defaultArgs: [],
      ignoredDirs: ["vendor", ".bundle", "tmp"],
    });
  }
  override async checkPrerequisites(ctx: Ctx): Promise<void> {
    requireMinVersion(await commandOutput(ctx, "ruby", "--version"), "Ruby", 3, 1);
  }
  async install(ctx: Ctx, _targetDir: string): Promise<string> {
    const r = await runProcess(ctx, "gem", ["install", "ruby-lsp"]);
    if (r.code !== 0) {
      throw new Error(`gem install failed: exit status ${r.code}: ${r.stdout + r.stderr}`);
    }
    const path = lookPath("ruby-lsp");
    if (path === undefined) {
      throw new Error(`ruby-lsp installed but not found in PATH: ${goLookPathError("ruby-lsp")}`);
    }
    return path;
  }
}

export function newRubyLspAdapter(): RubyLspAdapter {
  return new RubyLspAdapter();
}
