import { Config } from "../config.ts";
import type { Ctx } from "../context.ts";
import { csharpRoslynRuntimeDependency } from "../csharp.ts";
import type { RuntimeDependency } from "../types.ts";
import { commandOutput, installManaged, requireMinVersion, SpecAdapter } from "./helpers.ts";

export class RoslynAdapter extends SpecAdapter {
  constructor() {
    super({
      id: "csharp",
      name: "C#",
      extensions: [".cs"],
      binaries: [
        { name: "roslyn-ls", check_args: ["--version"] },
        { name: "csharp-ls", check_args: ["--version"] },
        { name: "omnisharp", args: ["--languageserver"], check_args: ["--version"] },
      ],
      prerequisites: [
        {
          name: ".NET SDK 10+",
          check_cmd: "dotnet --version",
          install_hint: "Install .NET SDK 10+ from https://dotnet.microsoft.com/download",
        },
      ],
      installGuide: {
        command: "knowns lsp install csharp",
        knowns_cmd: "knowns lsp install csharp",
        url: "https://www.nuget.org/packages/Microsoft.CodeAnalysis.LanguageServer.neutral",
        notes: "Downloads Roslyn LS from NuGet and requires .NET SDK 10+",
      },
      canInstall: true,
      defaultArgs: [],
      ignoredDirs: ["bin", "obj", ".vs", "packages"],
    });
  }
  override async checkPrerequisites(ctx: Ctx): Promise<void> {
    requireMinVersion(await commandOutput(ctx, "dotnet", "--version"), ".NET SDK", 10, 0);
  }
  override runtimeDeps(): RuntimeDependency[] {
    return [csharpRoslynRuntimeDependency(new Config())];
  }
  install(ctx: Ctx, targetDir: string): Promise<string> {
    return installManaged(this, ctx, targetDir);
  }
}

export function newRoslynAdapter(): RoslynAdapter {
  return new RoslynAdapter();
}
