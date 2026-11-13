// Port of internal/lsp/csharp.go.
import { readdirSync } from "node:fs";
import { extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { goLookPathError } from "../platform/goerror.ts";
import type { Config } from "./config.ts";
import { type Ctx, withTimeout } from "./context.ts";
import { resolveDotnet10, stringSetting } from "./dotnet.ts";
import type { LookPath, RunCheck, RunCommand } from "./exec.ts";
import type { Installer } from "./installer.ts";
import { csharpLogPath, RuntimeError } from "./runtime-error.ts";
import {
  type BackendAttempt,
  BackendAttemptChosen,
  BackendAttemptFailed,
  BackendAttemptSkipped,
  BaseAdapter,
  type Binary,
  type BinaryCandidate,
  CSharpBackendAuto,
  CSharpBackendCSharp,
  CSharpBackendOmni,
  CSharpBackendRoslyn,
  CSharpLanguageID,
  type InstallGuide,
  type LanguageAdapter,
  type Prerequisite,
  RoslynLanguageServerVersion,
  RoslynNuGetPackagePrefix,
  type RuntimeDependency,
  type ServerCommand,
} from "./types.ts";

export {
  BackendAttemptChosen,
  BackendAttemptFailed,
  BackendAttemptSkipped,
  CSharpBackendAuto,
  CSharpBackendCSharp,
  CSharpBackendOmni,
  CSharpBackendRoslyn,
  CSharpLanguageID,
  csharpLogPath,
  RoslynLanguageServerVersion,
  RoslynNuGetPackagePrefix,
};

export interface CSharpProjectSelection {
  path: string;
  kind: string;
}

export interface CSharpBackend {
  id: string;
  binary: Binary;
  buildArgs?: (root: string, selection: CSharpProjectSelection) => string[];
}

export interface CSharpResolveOptions {
  lookPath?: LookPath;
  runCheck?: RunCheck;
  runCommand?: RunCommand;
  installer?: Installer;
  autoInstallRoslyn?: boolean;
}

function goOS(): string {
  return process.platform === "win32" ? "windows" : process.platform;
}
function goArch(): string {
  switch (process.arch) {
    case "x64":
      return "amd64";
    case "ia32":
      return "386";
    default:
      return process.arch;
  }
}
/** CurrentPlatformID, e.g. "darwin-arm64". */
function currentPlatformID(): string {
  return `${goOS()}-${goArch()}`;
}

export function csharpBackends(): CSharpBackend[] {
  return [
    { id: CSharpBackendRoslyn, binary: { name: "roslyn-ls", checkArgs: ["--version"] } },
    {
      id: CSharpBackendCSharp,
      binary: { name: "csharp-ls", checkArgs: ["--version"] },
      buildArgs: csharpLSArgs,
    },
    {
      id: CSharpBackendOmni,
      binary: { name: "omnisharp", args: ["--languageserver"], checkArgs: ["--version"] },
    },
  ];
}

export function csharpBackendIDs(): string[] {
  return csharpBackends().map((b) => b.id);
}

export function isCSharpBackendID(id: string): boolean {
  return csharpBackends().some((b) => b.id === id);
}

function csharpBackendByID(id: string): CSharpBackend | undefined {
  return csharpBackends().find((b) => b.id === id);
}

export function resolveCSharpBackend(
  ctx: Ctx,
  root: string,
  cfg: Config,
  lookPath: LookPath | undefined,
  runCheck: RunCheck | undefined,
): Promise<[ServerCommand, boolean]> {
  return resolveCSharpBackendWithOptions(ctx, root, cfg, { lookPath, runCheck });
}

function notFound(name: string): string {
  return goLookPathError(name);
}

export async function resolveCSharpBackendWithOptions(
  ctx: Ctx,
  root: string,
  cfg: Config,
  opts: CSharpResolveOptions,
): Promise<[ServerCommand, boolean]> {
  const look: LookPath = opts.lookPath ?? (() => undefined);
  const selection = discoverCSharpProject(root, cfg.projectPathOverride(CSharpLanguageID));
  let backendID = cfg.backendOverride(CSharpLanguageID);
  if (backendID === "") backendID = CSharpBackendAuto;

  let candidates: CSharpBackend[];
  const autoMode = backendID === CSharpBackendAuto;
  if (autoMode) {
    candidates = csharpBackends();
  } else {
    const backend = csharpBackendByID(backendID);
    if (!backend) {
      return [
        {
          language: CSharpLanguageID,
          name: "",
          path: "",
          args: [],
          backend: backendID,
          projectPath: selection.path,
          logPath: csharpLogPath(root, backendID),
          attempts: [
            { backend: backendID, status: BackendAttemptFailed, reason: "unknown backend" },
          ],
        },
        false,
      ];
    }
    candidates = [backend];
  }

  const attempts: BackendAttempt[] = [];
  const skippedAfter = (idx: number) => {
    if (!autoMode) return;
    for (const skipped of candidates.slice(idx + 1)) {
      attempts.push({
        backend: skipped.id,
        status: BackendAttemptSkipped,
        reason: "earlier backend selected",
      });
    }
  };

  for (const [idx, backend] of candidates.entries()) {
    if (backend.id === CSharpBackendRoslyn && opts.installer) {
      const [cmd, attempt, ok] = await resolveManagedRoslyn(ctx, root, cfg, opts, selection);
      attempts.push(attempt);
      if (ok) {
        skippedAfter(idx);
        cmd.attempts = attempts;
        return [cmd, true];
      }
      if (cmd.path !== "") continue;
    }

    const path = look(backend.binary.name);
    if (path === undefined) {
      attempts.push({
        backend: backend.id,
        status: BackendAttemptFailed,
        reason: notFound(backend.binary.name),
      });
      continue;
    }
    const checkArgs = backend.binary.checkArgs ?? [];
    if (opts.runCheck && checkArgs.length > 0) {
      const t = withTimeout(ctx, 2000);
      try {
        await opts.runCheck(t.ctx, path, ...checkArgs);
      } catch (e) {
        attempts.push({
          backend: backend.id,
          status: BackendAttemptFailed,
          reason: e instanceof Error ? e.message : String(e),
          path,
        });
        continue;
      } finally {
        t.cancel();
      }
    }
    const args = [...(backend.binary.args ?? [])];
    if (backend.buildArgs) args.push(...backend.buildArgs(root, selection));
    attempts.push({ backend: backend.id, status: BackendAttemptChosen, path });
    skippedAfter(idx);
    return [
      {
        language: CSharpLanguageID,
        name: backend.binary.name,
        path,
        args,
        backend: backend.id,
        projectPath: selection.path,
        logPath: csharpLogPath(root, backend.id),
        attempts,
      },
      true,
    ];
  }

  return [
    {
      language: CSharpLanguageID,
      name: "",
      path: "",
      args: [],
      backend: backendID,
      projectPath: selection.path,
      logPath: csharpLogPath(root, backendID),
      attempts,
    },
    false,
  ];
}

export function csharpBackendUnavailableError(root: string, cmd: ServerCommand): RuntimeError {
  const backend = cmd.backend && cmd.backend !== "" ? cmd.backend : CSharpBackendAuto;
  return new RuntimeError({
    code: "csharp_backend_unavailable",
    language: CSharpLanguageID,
    backend,
    message: "No C# LSP backend is available",
    remediation:
      "Run `knowns lsp install csharp` for managed Roslyn LS, install .NET SDK 10+, or configure backend/path overrides.",
    logPath: csharpLogPath(root, backend),
    attempts: cmd.attempts,
  });
}

/** Go's dependencyAdapter: a bare adapter that only carries runtime dependencies. */
class CSharpDependencyAdapter extends BaseAdapter implements LanguageAdapter {
  constructor(
    private readonly languageID: string,
    private readonly deps: RuntimeDependency[],
  ) {
    super();
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
  async checkPrerequisites(): Promise<void> {}
  installGuide(): InstallGuide {
    return {};
  }
  canInstall(): boolean {
    return this.deps.length > 0;
  }
  runtimeDeps(): RuntimeDependency[] {
    return this.deps;
  }
  async install(): Promise<string> {
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

async function resolveManagedRoslyn(
  ctx: Ctx,
  root: string,
  cfg: Config,
  opts: CSharpResolveOptions,
  selection: CSharpProjectSelection,
): Promise<[ServerCommand, BackendAttempt, boolean]> {
  const empty = (): ServerCommand => ({ language: "", name: "", path: "", args: [] });
  const dep = csharpRoslynRuntimeDependency(cfg);
  const logPath = csharpLogPath(root, CSharpBackendRoslyn);
  let serverPath = "";
  let installReason = "";
  if (opts.installer) {
    const adapter = new CSharpDependencyAdapter(CSharpLanguageID, [dep]);
    const installed = opts.installer.isInstalled(adapter);
    if (installed) {
      serverPath = installed;
    } else if (opts.autoInstallRoslyn) {
      try {
        serverPath = await opts.installer.install(ctx, adapter);
      } catch (e) {
        installReason = e instanceof Error ? e.message : String(e);
      }
    } else {
      installReason = "managed Roslyn LS is not installed; run: knowns lsp install csharp";
    }
  }
  if (serverPath !== "") {
    let dotnetPath: string;
    try {
      dotnetPath = await resolveDotnet10(ctx, cfg, opts.lookPath, opts.runCommand, logPath);
    } catch (e) {
      return [
        {
          language: CSharpLanguageID,
          name: "",
          path: serverPath,
          args: [],
          backend: CSharpBackendRoslyn,
          projectPath: selection.path,
          logPath,
        },
        {
          backend: CSharpBackendRoslyn,
          status: BackendAttemptFailed,
          reason: e instanceof Error ? e.message : String(e),
          path: serverPath,
        },
        false,
      ];
    }
    return [
      {
        language: CSharpLanguageID,
        name: "dotnet",
        path: dotnetPath,
        args: [serverPath, "--stdio"],
        backend: CSharpBackendRoslyn,
        projectPath: selection.path,
        logPath,
      },
      { backend: CSharpBackendRoslyn, status: BackendAttemptChosen, path: serverPath },
      true,
    ];
  }
  if (installReason !== "") {
    return [
      empty(),
      { backend: CSharpBackendRoslyn, status: BackendAttemptFailed, reason: installReason },
      false,
    ];
  }
  return [
    empty(),
    {
      backend: CSharpBackendRoslyn,
      status: BackendAttemptFailed,
      reason: "managed Roslyn LS installer is not configured",
    },
    false,
  ];
}

export function csharpLSArgs(root: string, selection: CSharpProjectSelection): string[] {
  if (selection.kind !== "sln" || selection.path === "") return [];
  return ["--solution", csharpLSProjectPath(root, selection.path)];
}

export function csharpLSProjectPath(root: string, projectPath: string): string {
  const rel = relative(root, projectPath);
  if (rel === "" || rel === "." || rel === ".." || isAbsolute(rel) || rel.startsWith(`..${sep}`)) {
    return projectPath;
  }
  return rel;
}

export function csharpRoslynRuntimeDependency(cfg: Config): RuntimeDependency {
  let version = cfg.versionOverride(CSharpLanguageID);
  if (version === "") version = RoslynLanguageServerVersion;
  const settings = cfg.languageSettings(CSharpLanguageID);
  const rid = csharpRoslynRID(goOS(), goArch());
  let packageName = stringSetting(settings, "roslynPackage");
  if (packageName === "") packageName = `${RoslynNuGetPackagePrefix}.${rid}`;
  let extractPath = stringSetting(settings, "roslynExtractPath");
  if (extractPath === "") {
    extractPath = join(
      "content",
      "LanguageServer",
      rid,
      "Microsoft.CodeAnalysis.LanguageServer.dll",
    )
      .split(sep)
      .join("/");
  }
  const dep: RuntimeDependency = {
    id: packageName,
    platform_id: currentPlatformID(),
    version,
    source: "nuget",
    archive_type: "nupkg",
    package_name: packageName,
    binary_name: "Microsoft.CodeAnalysis.LanguageServer.dll",
    extract_path: extractPath,
  };
  const ps = stringSetting(settings, "roslynPackageSource");
  if (ps !== "") dep.package_source = ps;
  const url = stringSetting(settings, "roslynPackageURL");
  if (url !== "") dep.url = url;
  const s256 = stringSetting(settings, "roslynSHA256");
  if (s256 !== "") dep.sha256 = s256;
  const s512 = stringSetting(settings, "roslynSHA512");
  if (s512 !== "") dep.sha512 = s512;
  return dep;
}

export function csharpRoslynRID(goos: string, goarch: string): string {
  let osPart = goos;
  if (goos === "darwin") osPart = "osx";
  else if (goos === "windows") osPart = "win";
  let archPart = goarch;
  if (goarch === "amd64") archPart = "x64";
  else if (goarch === "386") archPart = "x86";
  return `${osPart}-${archPart}`;
}

export function discoverCSharpProject(root: string, override: string): CSharpProjectSelection {
  if (override !== "") {
    const path = isAbsolute(override) ? override : join(root, override);
    return { path: normalize(path), kind: csharpProjectKind(path) };
  }
  const sln = discoverCSharpProjectByExt(root, [".sln", ".slnx"]);
  if (sln.path !== "") return sln;
  return discoverCSharpProjectByExt(root, [".csproj"]);
}

function discoverCSharpProjectByExt(root: string, exts: string[]): CSharpProjectSelection {
  const allowed = new Set(exts.map((e) => e.toLowerCase()));
  let queue: string[] = [root];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => {
      const x = a.name.toLowerCase();
      const y = b.name.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
    const dirs: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (isCSharpIgnoredDir(entry.name)) continue;
        dirs.push(join(dir, entry.name));
        continue;
      }
      if (allowed.has(extname(entry.name).toLowerCase())) {
        const path = join(dir, entry.name);
        return { path, kind: csharpProjectKind(path) };
      }
    }
    queue = queue.concat(dirs);
  }
  return { path: "", kind: "" };
}

export function csharpProjectKind(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".sln":
      return "sln";
    case ".slnx":
      return "slnx";
    case ".csproj":
      return "csproj";
    default:
      return "";
  }
}

function isCSharpIgnoredDir(name: string): boolean {
  switch (name) {
    case ".git":
    case ".knowns":
    case "bin":
    case "obj":
    case ".vs":
    case "packages":
    case "node_modules":
    case "vendor":
    case "target":
    case "dist":
    case "build":
      return true;
    default:
      return false;
  }
}

export function describeCSharpAttempts(attempts: BackendAttempt[]): string {
  return attempts
    .map((a) =>
      a.reason === undefined || a.reason === ""
        ? `${a.backend}:${a.status}`
        : `${a.backend}:${a.status}(${a.reason})`,
    )
    .join(", ");
}
