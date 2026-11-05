// Port of internal/lsp/dependency_adapter.go: a minimal adapter that only carries runtime
// dependencies, used to install and report dependencies that are not owned by one adapter.
import { homedir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "./context.ts";
import {
  BaseAdapter,
  type BinaryCandidate,
  type InstallGuide,
  type LanguageAdapter,
  type Prerequisite,
  type RuntimeDependency,
} from "./types.ts";

/** DefaultLSPBaseDir: ~/.knowns/lsp-servers (relative .knowns/lsp-servers when no home exists). */
export function defaultLSPBaseDir(): string {
  let home = "";
  try {
    // os.UserHomeDir reads $HOME (USERPROFILE on Windows) on every call; Bun's homedir() can cache.
    home = (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) || homedir();
  } catch {
    home = "";
  }
  if (home === "") return join(".knowns", "lsp-servers");
  return join(home, ".knowns", "lsp-servers");
}

export class DependencyAdapter extends BaseAdapter implements LanguageAdapter {
  private readonly languageID: string;
  private readonly deps: RuntimeDependency[];

  constructor(id: string, deps: RuntimeDependency[]) {
    super();
    this.languageID = id;
    this.deps = deps;
  }
  id(): string {
    return this.languageID;
  }
  name(): string {
    return this.languageID;
  }
  extensions(): string[] {
    return [];
  }
  binaries(): BinaryCandidate[] {
    return [];
  }
  prerequisites(): Prerequisite[] {
    return [];
  }
  async checkPrerequisites(_ctx: Ctx): Promise<void> {}
  installGuide(): InstallGuide {
    return {};
  }
  canInstall(): boolean {
    return this.deps.length > 0;
  }
  runtimeDeps(): RuntimeDependency[] {
    return this.deps;
  }
  async install(_ctx: Ctx, _targetDir: string): Promise<string> {
    return "";
  }
  installedPath(): string | undefined {
    return undefined;
  }
  defaultArgs(): string[] {
    return [];
  }
  initializeParams(): Record<string, unknown> | undefined {
    return undefined;
  }
  initializationOptions(): Record<string, unknown> | undefined {
    return undefined;
  }
}
