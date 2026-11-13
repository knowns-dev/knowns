import { goLookPathError } from "../../platform/goerror.ts";
import type { Ctx } from "../context.ts";
import { lookPath, runProcess } from "../exec.ts";
import { commandOutput, preferredCmd, requireMinVersion, SpecAdapter } from "./helpers.ts";

export class PythonAdapter extends SpecAdapter {
  constructor() {
    super({
      id: "python",
      name: "Python",
      extensions: [".py"],
      binaries: [
        { name: "pylsp", check_args: ["--version"] },
        { name: "pyright-langserver", args: ["--stdio"], check_args: ["--version"] },
      ],
      prerequisites: [
        {
          name: "Python 3.9+",
          check_cmd: "python3 --version",
          install_hint: "Install Python 3.9+ from https://www.python.org/downloads/",
        },
      ],
      installGuide: {
        command: "pip install python-lsp-server",
        knowns_cmd: "knowns lsp install python",
        notes: "Requires Python 3.9+ installed; pyright-langserver is also supported",
      },
      canInstall: true,
      defaultArgs: [],
      ignoredDirs: ["__pycache__", ".venv", "venv", ".tox", ".mypy_cache"],
    });
  }
  override async checkPrerequisites(ctx: Ctx): Promise<void> {
    let output: string;
    try {
      output = await commandOutput(ctx, "python3", "--version");
    } catch {
      output = await commandOutput(ctx, "python", "--version");
    }
    requireMinVersion(output, "Python", 3, 9);
  }
  async install(ctx: Ctx, _targetDir: string): Promise<string> {
    const pm = preferredCmd("uv", "pip3", "pip");
    const args =
      pm === "uv" ? ["tool", "install", "python-lsp-server"] : ["install", "python-lsp-server"];
    const r = await runProcess(ctx, pm, args);
    if (r.code !== 0) {
      throw new Error(`${pm} install failed: exit status ${r.code}: ${r.stdout + r.stderr}`);
    }
    const path = lookPath("pylsp");
    if (path === undefined) {
      throw new Error(`pylsp installed but not found in PATH: ${goLookPathError("pylsp")}`);
    }
    return path;
  }
}

export function newPythonAdapter(): PythonAdapter {
  return new PythonAdapter();
}
