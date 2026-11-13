import type { Ctx } from "../context.ts";
import type { RuntimeDependency } from "../types.ts";
import { commandOutput, installManaged, requireMinVersion, SpecAdapter } from "./helpers.ts";

export class JdtlsAdapter extends SpecAdapter {
  constructor() {
    super({
      id: "java",
      name: "Java",
      extensions: [".java"],
      binaries: [{ name: "jdtls", check_args: ["--version"] }],
      prerequisites: [
        {
          name: "Java JDK 17+",
          check_cmd: "java -version",
          install_hint: "Install JDK 17+ from https://adoptium.net/",
        },
      ],
      installGuide: {
        knowns_cmd: "knowns lsp install java",
        url: "https://github.com/eclipse-jdtls/eclipse.jdt.ls",
        notes: "Requires JDK 17+",
      },
      canInstall: true,
      defaultArgs: [],
      ignoredDirs: ["target", ".gradle", "build", ".idea", "out"],
    });
  }
  override async checkPrerequisites(ctx: Ctx): Promise<void> {
    requireMinVersion(await commandOutput(ctx, "java", "-version"), "Java", 17, 0);
  }
  override runtimeDeps(): RuntimeDependency[] {
    const version = "1.58.0";
    const url =
      "https://download.eclipse.org/jdtls/milestones/1.58.0/jdt-language-server-1.58.0-202604151538.tar.gz";
    const sha256 = "2a5bbe55ec91b4325392050dc422cead3220a2459b3766be35e1fff45b4a50d9";
    const mk = (platform_id: string): RuntimeDependency => ({
      id: version,
      platform_id,
      url,
      sha256,
      archive_type: "tar.gz",
      binary_name: "jdtls",
      extract_path: "bin/jdtls",
    });
    return ["darwin-arm64", "darwin-amd64", "linux-amd64", "linux-arm64", "windows-amd64"].map(mk);
  }
  install(ctx: Ctx, targetDir: string): Promise<string> {
    return installManaged(this, ctx, targetDir, "install jdtls");
  }
}

export function newJdtlsAdapter(): JdtlsAdapter {
  return new JdtlsAdapter();
}
