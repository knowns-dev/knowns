// Port of internal/lsp/installer.go: download, verify, extract and select managed language
// servers under <baseDir>/<language>/<cache>-<version>/, with .selected.json and
// .last-error.json byte-compatible with Go 0.34.x.
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { type Ctx, ctxErr, raceAbort } from "./context.ts";
import { errorMessage } from "./errors.ts";
import { defaultRunCommand, type RunCommand } from "./exec.ts";
import { acquireLanguageInstallLock, acquireLanguageInstallLockSync } from "./installer-lock.ts";
import type {
  DependencyResolution,
  DependencyResolver,
  InstallOptions,
  InstallSelector,
  LanguageAdapter,
  ManagedDependencyStatus,
  RuntimeDependency,
} from "./types.ts";

/** CurrentPlatformID: GOOS-GOARCH of the running process (darwin-arm64, linux-amd64, windows-amd64). */
export function currentPlatformID(): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  return `${os}-${arch}`;
}

const isWindows = (): boolean => process.platform === "win32";

interface DependencySelection {
  version: string;
  version_id: string;
  source: string;
  cache_path: string;
  selected_path: string;
  requested_version?: string;
  resolved_version?: string;
  source_location?: string;
  integrity?: string;
  installed_at?: string;
  verified: boolean;
}

interface DependencyLastError {
  operation: string;
  error: string;
}

interface SelectionSnapshot {
  data?: string;
  exists: boolean;
}

type WriteSelectionFn = (
  adapter: LanguageAdapter,
  resolution: DependencyResolution,
  selectedPath: string,
) => void;

/** Installer handles downloading, extracting, and verifying LSP server binaries. */
export class Installer {
  readonly baseDir: string;
  /** Command runner (npm); tests replace it. */
  runCommand: RunCommand = defaultRunCommand;
  /** Test hook, like Go's writeSelectionOverride. */
  writeSelectionOverride: WriteSelectionFn | undefined;
  private readonly installing = new Map<string, Promise<void>>();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  install(ctx: Ctx, adapter: LanguageAdapter): Promise<string> {
    return this.installWithOptions(ctx, adapter, { selector: {} });
  }

  installWithOptions(ctx: Ctx, adapter: LanguageAdapter, opts: InstallOptions): Promise<string> {
    return this.installInner(ctx, adapter, opts ?? { selector: {} }, false);
  }

  private async installInner(
    ctx: Ctx,
    adapter: LanguageAdapter,
    opts: InstallOptions,
    coalesceExisting: boolean,
  ): Promise<string> {
    validateInstallSelector(opts.selector ?? {});
    const selector = opts.selector ?? {};
    const langID = adapter.id();

    // Concurrent install prevention: wait for an in-process install of the same language.
    const inflight = this.installing.get(langID);
    if (inflight) {
      await raceAbort(ctx, inflight);
      return this.installInner(ctx, adapter, opts, true);
    }
    let release!: () => void;
    this.installing.set(
      langID,
      new Promise<void>((r) => {
        release = r;
      }),
    );
    try {
      const lock = await acquireLanguageInstallLock(ctx, this.baseDir, langID);
      try {
        return await this.installLocked(
          ctx,
          adapter,
          opts,
          selector,
          coalesceExisting || lock.waited,
        );
      } finally {
        lock.unlock();
      }
    } finally {
      this.installing.delete(langID);
      release();
    }
  }

  private async installLocked(
    ctx: Ctx,
    adapter: LanguageAdapter,
    opts: InstallOptions,
    selector: InstallSelector,
    coalesceExisting: boolean,
  ): Promise<string> {
    const langID = adapter.id();
    let dep: RuntimeDependency;
    try {
      dep = this.findDep(adapter);
    } catch (e) {
      this.tryWriteLastError(langID, "install", e);
      throw e;
    }
    if (coalesceExisting) {
      const selection = this.readSelection(langID);
      if (selection && selectionSatisfiesRequest(selection, dep, selector)) {
        if (existsSync(selection.selected_path)) {
          if (opts.beforeCleanup) await opts.beforeCleanup(selection.selected_path);
          this.tryCleanupLocked(langID);
          this.tryClearLastError(langID);
          return selection.selected_path;
        }
      }
    }
    const previousSelection = this.snapshotSelection(langID);

    let resolution: DependencyResolution;
    try {
      resolution = await this.resolveDependency(ctx, adapter, dep, opts);
    } catch (e) {
      this.tryWriteLastError(langID, "install", e);
      throw e;
    }

    let staged: { path: string; rollback: () => void; commit: () => void };
    try {
      staged = await this.installResolvedDependency(ctx, adapter, resolution.dependency);
    } catch (e) {
      this.tryWriteLastError(langID, "install", e);
      throw e;
    }
    const writeSelection: WriteSelectionFn =
      this.writeSelectionOverride ?? ((a, r, p) => this.writeSelectionResolution(a, r, p));
    try {
      writeSelection(adapter, resolution, staged.path);
    } catch (e) {
      staged.rollback();
      this.tryWriteLastError(langID, "install", e);
      throw e;
    }
    if (opts.beforeCleanup) {
      try {
        await opts.beforeCleanup(staged.path);
      } catch (e) {
        staged.rollback();
        let err = e instanceof Error ? e : new Error(String(e));
        try {
          this.restoreSelection(langID, previousSelection);
        } catch (restoreErr) {
          err = new Error(
            `${err.message} (restore previous selection: ${errorMessage(restoreErr)})`,
          );
        }
        this.tryWriteLastError(langID, "install", err);
        throw err;
      }
    }
    staged.commit();
    this.tryClearLastError(langID);
    this.tryCleanupLocked(langID);
    return staged.path;
  }

  /** IsInstalled: the selected binary when present, else the expected recommended path. */
  isInstalled(adapter: LanguageAdapter): string | undefined {
    const selection = this.readSelection(adapter.id());
    if (selection && selection.selected_path !== "" && existsSync(selection.selected_path)) {
      return selection.selected_path;
    }
    let dep: RuntimeDependency;
    try {
      dep = this.findDep(adapter);
    } catch {
      return undefined;
    }
    if (dep.recommended_version) dep = { ...dep, version: dep.recommended_version };
    const p = this.expectedBinaryPath(adapter.id(), dep);
    return existsSync(p) ? p : undefined;
  }

  /** Status reports managed dependency state for an adapter. */
  status(adapter: LanguageAdapter): ManagedDependencyStatus {
    const status: ManagedDependencyStatus = {
      language_id: adapter.id(),
      verified: false,
      cleanup_eligible: false,
      installed: false,
      installable: adapter.canInstall(),
    };
    let dep: RuntimeDependency;
    try {
      dep = this.findDep(adapter);
    } catch (e) {
      status.install_error = errorMessage(e);
      const last = this.readLastError(adapter.id());
      if (last) status.install_error = last.error;
      return pruneStatus(status);
    }
    const selectedDep: RuntimeDependency = dep.recommended_version
      ? { ...dep, version: dep.recommended_version }
      : dep;
    status.version = dependencyVersion(selectedDep);
    status.source = dependencySource(dep);
    status.cache_path = this.versionDir(adapter.id(), selectedDep);
    status.selected_version_id = dependencyVersionID(selectedDep);
    const selection = this.readSelection(adapter.id());
    if (selection) {
      status.version = selection.version;
      status.requested_version = selection.requested_version ?? "";
      status.resolved_version = selection.resolved_version ?? "";
      if (status.resolved_version === "") status.resolved_version = selection.version;
      status.source = selection.source;
      status.source_location = selection.source_location ?? "";
      status.integrity = selection.integrity ?? "";
      status.installed_at = selection.installed_at ?? "";
      status.verified = selection.verified;
      status.cache_path = selection.cache_path;
      status.selected_path = selection.selected_path;
      status.selected_version_id = selection.version_id;
      if (existsSync(selection.selected_path)) status.installed = true;
    }
    const last = this.readLastError(adapter.id());
    if (last) {
      if (last.operation === "update") status.update_error = last.error;
      else status.install_error = last.error;
    }
    status.cleanup_eligible = this.cleanupEligible(adapter.id(), status.selected_path ?? "");
    return pruneStatus(status);
  }

  /** Remove removes all installed versions for a language. */
  remove(languageID: string): void {
    rmSync(join(this.baseDir, languageID), { recursive: true, force: true });
  }

  /**
   * Cleanup removes old versions, keeping the runtime-selected one. Without a selection it is a
   * no-op. Blocks (synchronously) while another TypeScript process holds the install lock.
   */
  cleanup(languageID: string): void {
    const lock = acquireLanguageInstallLockSync(this.baseDir, languageID);
    try {
      this.cleanupLocked(languageID);
    } finally {
      lock.unlock();
    }
  }

  private cleanupLocked(languageID: string): void {
    const langDir = join(this.baseDir, languageID);
    const selection = this.readSelection(languageID);
    if (!selection || selection.selected_path === "") return;
    const selectedDir = this.selectedVersionDir(languageID, selection.selected_path);
    if (selectedDir === undefined) return;
    const entries = readdirSync(langDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = join(langDir, e.name);
      if (p === selectedDir) continue;
      rmSync(p, { recursive: true, force: true });
    }
  }

  private tryCleanupLocked(languageID: string): void {
    try {
      this.cleanupLocked(languageID);
    } catch {
      // Go ignores this error
    }
  }

  private findDep(adapter: LanguageAdapter): RuntimeDependency {
    const platform = currentPlatformID();
    for (const dep of adapter.runtimeDeps()) {
      if (!dep.platform_id || dep.platform_id === platform) return dep;
    }
    throw new Error(`no runtime dependency for platform ${platform}`);
  }

  // ---- resolution ----

  private async resolveDependency(
    ctx: Ctx,
    adapter: LanguageAdapter,
    dep: RuntimeDependency,
    opts: InstallOptions,
  ): Promise<DependencyResolution> {
    const selector = opts.selector ?? {};
    let resolver: DependencyResolver | undefined = opts.releaseResolver;
    if (isNPMDependency(dep)) {
      resolver = opts.npmResolver ?? ((c, d, s) => this.resolveNPMDependency(c, d, s));
    } else if (!resolver && typeof adapter.resolveRuntimeDependency === "function") {
      resolver = adapter.resolveRuntimeDependency.bind(adapter);
    }
    if (resolver) {
      const resolution = await resolver(ctx, dep, selector);
      return normalizeResolution(dep, selector, resolution);
    }
    return resolveStaticDependency(dep, selector);
  }

  private async resolveNPMDependency(
    ctx: Ctx,
    dep: RuntimeDependency,
    selector: InstallSelector,
  ): Promise<DependencyResolution> {
    const requested = requestedVersionForDependency(dep, selector);
    let target = (selector.version ?? "").trim();
    const shouldResolve = target !== "" || !!selector.latest || !!dep.recommended_version;
    if (selector.latest) target = "latest";
    else if (target === "" && dep.recommended_version) target = dep.recommended_version;
    else if (target === "") target = dependencyVersion(dep);
    if (!shouldResolve) {
      const resolvedDep = { ...dep };
      return normalizeResolution(dep, selector, {
        dependency: resolvedDep,
        requested_version: requested,
        resolved_version: dependencyVersion(resolvedDep),
        source: dependencySourceLocation(resolvedDep),
        integrity: dependencyIntegrity(resolvedDep),
        verified: false,
      });
    }
    const packages = npmPackages(dep);
    const first = packages[0];
    if (packages.length === 0 || first === undefined || first.trim() === "") {
      throw new Error("npm dependency has no package name");
    }
    const packageSpec = npmPackageSpec(first, target);
    let output: string;
    try {
      output = await this.runCommand(
        ctx,
        "npm",
        "view",
        packageSpec,
        "version",
        "dist.integrity",
        "--json",
      );
    } catch (e) {
      const out = (e as { output?: string }).output ?? "";
      throw new Error(`resolve npm package ${packageSpec}: ${errorMessage(e)}: ${out.trim()}`);
    }
    let version: string;
    let integrity: string;
    try {
      [version, integrity] = parseNPMMetadata(output);
    } catch (e) {
      throw new Error(`parse npm metadata for ${packageSpec}: ${errorMessage(e)}`);
    }
    if (version === "") {
      throw new Error(`npm metadata for ${packageSpec} did not include a resolved version`);
    }
    if (integrity === "") {
      throw new Error(`npm metadata for ${packageSpec} did not include integrity`);
    }
    const resolvedDep = { ...dep, version };
    return normalizeResolution(dep, selector, {
      dependency: resolvedDep,
      requested_version: requested,
      resolved_version: version,
      source: packageSpec,
      integrity,
      verified: !!dep.recommended_version && version === dep.recommended_version,
    });
  }

  // ---- installation ----

  private async installResolvedDependency(
    ctx: Ctx,
    adapter: LanguageAdapter,
    dep: RuntimeDependency,
  ): Promise<{ path: string; rollback: () => void; commit: () => void }> {
    const langDir = join(this.baseDir, adapter.id());
    try {
      mkdirSync(langDir, { recursive: true, mode: 0o755 });
    } catch (e) {
      throw new Error(`create language dir: ${errorMessage(e)}`);
    }
    let stagingDir: string;
    try {
      stagingDir = mkdtempSync(join(langDir, ".install-"));
    } catch (e) {
      throw new Error(`create staging dir: ${errorMessage(e)}`);
    }
    const rmStaging = () => rmSync(stagingDir, { recursive: true, force: true });
    let stagedPath: string;
    try {
      stagedPath = await this.installDependencyAt(ctx, stagingDir, dep);
    } catch (e) {
      rmStaging();
      throw e;
    }
    const relPath = relative(stagingDir, stagedPath);
    if (relPath.startsWith("..")) {
      rmStaging();
      throw new Error("installed binary escaped staging dir");
    }

    const versionDir = this.versionDir(adapter.id(), dep);
    const backupDir = `${versionDir}.previous`;
    rmSync(backupDir, { recursive: true, force: true });
    let hadPrevious = false;
    if (existsSync(versionDir)) {
      try {
        renameSync(versionDir, backupDir);
      } catch (e) {
        rmStaging();
        throw new Error(`preserve selected version: ${errorMessage(e)}`);
      }
      hadPrevious = true;
    }
    try {
      renameSync(stagingDir, versionDir);
    } catch (e) {
      if (hadPrevious) {
        try {
          renameSync(backupDir, versionDir);
        } catch {
          // best effort, as in Go
        }
      }
      rmStaging();
      throw new Error(`select installed version: ${errorMessage(e)}`);
    }
    const rollback = () => {
      rmSync(versionDir, { recursive: true, force: true });
      if (hadPrevious) {
        try {
          renameSync(backupDir, versionDir);
        } catch {
          // best effort
        }
      }
    };
    const commit = () => rmSync(backupDir, { recursive: true, force: true });
    return { path: join(versionDir, relPath), rollback, commit };
  }

  private installDependencyAt(
    ctx: Ctx,
    versionDir: string,
    dep: RuntimeDependency,
  ): Promise<string> {
    if (isNuGetDependency(dep)) return this.installNuGet(ctx, versionDir, dep);
    if (isNPMDependency(dep)) return this.installNPM(ctx, versionDir, dep);
    return this.installArchive(ctx, versionDir, dep);
  }

  private async installArchive(
    ctx: Ctx,
    versionDir: string,
    dep: RuntimeDependency,
  ): Promise<string> {
    let tmpFile: string;
    try {
      tmpFile = await this.download(ctx, dep.url ?? "");
    } catch (e) {
      rmSync(versionDir, { recursive: true, force: true });
      throw new Error(`download: ${errorMessage(e)}`);
    }
    try {
      try {
        this.verifySHA256(tmpFile, dep.sha256 ?? "");
      } catch (e) {
        rmSync(versionDir, { recursive: true, force: true });
        throw e;
      }
      const binaryPath = this.binaryPath(versionDir, dep);
      try {
        this.extract(tmpFile, binaryPath, dep);
      } catch (e) {
        rmSync(versionDir, { recursive: true, force: true });
        throw new Error(`extract: ${errorMessage(e)}`);
      }
      try {
        chmodSync(binaryPath, 0o755);
      } catch (e) {
        rmSync(versionDir, { recursive: true, force: true });
        throw new Error(`chmod: ${errorMessage(e)}`);
      }
      return binaryPath;
    } finally {
      rmQuiet(tmpFile);
    }
  }

  private async installNPM(ctx: Ctx, versionDir: string, dep: RuntimeDependency): Promise<string> {
    try {
      mkdirSync(versionDir, { recursive: true, mode: 0o755 });
    } catch (e) {
      throw new Error(`create npm prefix: ${errorMessage(e)}`);
    }
    const args = ["install", "--prefix", versionDir, "--no-audit", "--no-fund"];
    for (const pkg of npmPackages(dep)) args.push(npmPackageSpec(pkg, dependencyVersion(dep)));
    try {
      await this.runCommand(ctx, "npm", ...args);
    } catch (e) {
      const out = (e as { output?: string }).output ?? "";
      rmSync(versionDir, { recursive: true, force: true });
      throw new Error(`npm install failed: ${errorMessage(e)}: ${out.trim()}`);
    }
    const binaryPath = this.binaryPath(versionDir, dep);
    if (!existsSync(binaryPath)) {
      rmSync(versionDir, { recursive: true, force: true });
      throw new Error(
        `npm install completed but ${binaryPath} was not found: no such file or directory`,
      );
    }
    if (!isWindows()) {
      try {
        chmodSync(binaryPath, 0o755);
      } catch {
        // ignored in Go
      }
    }
    return binaryPath;
  }

  private async installNuGet(
    ctx: Ctx,
    versionDir: string,
    dep: RuntimeDependency,
  ): Promise<string> {
    let url = dep.url ?? "";
    if (url === "") url = nugetPackageURL(dep);
    if (url === "") throw new Error("nuget package URL is not configured");
    let tmpFile: string;
    try {
      tmpFile = await this.download(ctx, url);
    } catch (e) {
      rmSync(versionDir, { recursive: true, force: true });
      throw new Error(`download: ${errorMessage(e)}`);
    }
    try {
      try {
        if (dep.sha256 && dep.sha256.toLowerCase() !== "todo")
          this.verifySHA256(tmpFile, dep.sha256);
        if (dep.sha512 && dep.sha512.toLowerCase() !== "todo")
          this.verifySHA512(tmpFile, dep.sha512);
      } catch (e) {
        rmSync(versionDir, { recursive: true, force: true });
        throw e;
      }
      try {
        this.extractZipAll(tmpFile, versionDir);
      } catch (e) {
        rmSync(versionDir, { recursive: true, force: true });
        throw new Error(`extract: ${errorMessage(e)}`);
      }
      const binaryPath = this.binaryPath(versionDir, dep);
      if (!existsSync(binaryPath)) {
        rmSync(versionDir, { recursive: true, force: true });
        throw new Error(
          `nuget install completed but ${binaryPath} was not found: no such file or directory`,
        );
      }
      return binaryPath;
    } finally {
      rmQuiet(tmpFile);
    }
  }

  versionDir(languageID: string, dep: RuntimeDependency): string {
    return join(
      this.baseDir,
      languageID,
      `${dependencyCacheName(dep)}-${dependencyVersionID(dep)}`,
    );
  }

  private expectedBinaryPath(languageID: string, dep: RuntimeDependency): string {
    return this.binaryPath(this.versionDir(languageID, dep), dep);
  }

  private binaryPath(versionDir: string, dep: RuntimeDependency): string {
    return dependencyBinaryPath(versionDir, dep, isWindows() ? "windows" : process.platform);
  }

  private async download(ctx: Ctx, url: string): Promise<string> {
    const res = await fetch(url, { signal: ctx });
    if (res.status !== 200) {
      throw new Error(`HTTP ${res.status}: ${res.status} ${res.statusText}`);
    }
    const data = new Uint8Array(await res.arrayBuffer());
    const tmp = join(tmpdir(), `knowns-lsp-download-${randomBytes(6).toString("hex")}`);
    writeFileSync(tmp, data, { mode: 0o600 });
    const aborted = ctxErr(ctx);
    if (aborted) {
      rmQuiet(tmp);
      throw aborted;
    }
    return tmp;
  }

  private verifySHA256(filePath: string, expected: string): void {
    const actual = createHash("sha256").update(readFileSync(filePath)).digest("hex");
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`SHA-256 mismatch: expected ${expected}, got ${actual}`);
    }
  }

  private verifySHA512(filePath: string, expected: string): void {
    const sum = createHash("sha512").update(readFileSync(filePath)).digest();
    // Go tries base64 first and only falls back to hex when base64 decoding fails.
    const decoded = decodeStdBase64(expected);
    if (decoded) {
      if (!decoded.equals(sum)) throw new Error("SHA-512 mismatch");
      return;
    }
    const actual = sum.toString("hex");
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`SHA-512 mismatch: expected ${expected}, got ${actual}`);
    }
  }

  private extract(archivePath: string, binaryPath: string, dep: RuntimeDependency): void {
    switch (dep.archive_type) {
      case "tar.gz":
        this.extractTarGz(archivePath, binaryPath, dep.extract_path ?? "");
        return;
      case "zip":
        this.extractZip(archivePath, binaryPath, dep.extract_path ?? "");
        return;
      case "binary":
        this.copyBinary(archivePath, binaryPath);
        return;
      default:
        throw new Error(`unsupported archive type: ${dep.archive_type ?? ""}`);
    }
  }

  private extractTarGz(archivePath: string, binaryPath: string, extractPath: string): void {
    const tar = gunzipSync(readFileSync(archivePath));
    for (const entry of readTar(tar)) {
      if (entry.name === extractPath || entry.name.endsWith(`/${extractPath}`)) {
        writeFileSync(binaryPath, entry.data, { mode: 0o755 });
        return;
      }
    }
    throw new Error(`file ${JSON.stringify(extractPath)} not found in tar.gz archive`);
  }

  private extractZip(archivePath: string, binaryPath: string, extractPath: string): void {
    const zip = readFileSync(archivePath);
    for (const entry of readZip(zip)) {
      if (entry.name === extractPath || entry.name.endsWith(`/${extractPath}`)) {
        writeFileSync(binaryPath, entry.read(), { mode: 0o755 });
        return;
      }
    }
    throw new Error(`file ${JSON.stringify(extractPath)} not found in zip archive`);
  }

  private extractZipAll(archivePath: string, targetDir: string): void {
    const cleanTarget = resolve(targetDir);
    for (const entry of readZip(readFileSync(archivePath))) {
      const name = sep === "\\" ? entry.name.replaceAll("/", "\\") : entry.name;
      const norm = join(name);
      if (norm === "." || norm.startsWith(`..${sep}`) || norm === ".." || isAbsolute(norm)) {
        throw new Error(`unsafe zip path ${JSON.stringify(entry.name)}`);
      }
      const target = join(cleanTarget, norm);
      if (!target.startsWith(cleanTarget + sep) && target !== cleanTarget) {
        throw new Error(`unsafe zip path ${JSON.stringify(entry.name)}`);
      }
      if (entry.isDir) {
        mkdirSync(target, { recursive: true, mode: entry.mode & 0o777 || 0o755 });
        continue;
      }
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      writeFileSync(target, entry.read(), { mode: entry.mode & 0o777 });
    }
  }

  private copyBinary(srcPath: string, dstPath: string): void {
    writeFileSync(dstPath, readFileSync(srcPath), { mode: 0o755 });
  }

  // ---- selection and last-error files ----

  private writeSelectionResolution(
    adapter: LanguageAdapter,
    resolution: DependencyResolution,
    selectedPath: string,
  ): void {
    const dep = resolution.dependency;
    const selection: Omit<DependencySelection, "verified"> & { verified?: boolean } = {
      version: resolution.resolved_version,
      version_id: dependencyVersionID(dep),
      source: dependencySource(dep),
      cache_path: this.versionDir(adapter.id(), dep),
      selected_path: selectedPath,
    };
    if (resolution.requested_version) selection.requested_version = resolution.requested_version;
    if (resolution.resolved_version) selection.resolved_version = resolution.resolved_version;
    if (resolution.source) selection.source_location = resolution.source;
    if (resolution.integrity) selection.integrity = resolution.integrity;
    selection.installed_at = rfc3339Nano(new Date());
    selection.verified = resolution.verified;
    this.writeSelectionData(adapter.id(), goJSON(selection));
  }

  private writeSelectionData(languageID: string, data: string): void {
    const langDir = join(this.baseDir, languageID);
    mkdirSync(langDir, { recursive: true, mode: 0o755 });
    const tmpPath = join(langDir, `.selected-${randomBytes(6).toString("hex")}.tmp`);
    try {
      writeFileSync(tmpPath, data, { mode: 0o644 });
      const target = join(langDir, ".selected.json");
      try {
        renameSync(tmpPath, target);
        return;
      } catch {
        // Windows does not replace an existing file with rename; keep the old one recoverable.
      }
      const backup = `${target}.previous`;
      rmQuiet(backup);
      try {
        renameSync(target, backup);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      try {
        renameSync(tmpPath, target);
      } catch (e) {
        try {
          renameSync(backup, target);
        } catch {
          // nothing more to do
        }
        throw e;
      }
      rmQuiet(backup);
    } finally {
      rmQuiet(tmpPath);
    }
  }

  private snapshotSelection(languageID: string): SelectionSnapshot {
    try {
      return {
        data: readFileSync(join(this.baseDir, languageID, ".selected.json"), "utf8"),
        exists: true,
      };
    } catch {
      return { exists: false };
    }
  }

  private restoreSelection(languageID: string, snapshot: SelectionSnapshot): void {
    if (snapshot.exists && snapshot.data !== undefined) {
      this.writeSelectionData(languageID, snapshot.data);
      return;
    }
    try {
      unlinkSync(join(this.baseDir, languageID, ".selected.json"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  private readSelection(languageID: string): DependencySelection | undefined {
    try {
      const raw = JSON.parse(
        readFileSync(join(this.baseDir, languageID, ".selected.json"), "utf8"),
      );
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
      const o = raw as Record<string, unknown>;
      const str = (k: string): string => (typeof o[k] === "string" ? (o[k] as string) : "");
      const sel: DependencySelection = {
        version: str("version"),
        version_id: str("version_id"),
        source: str("source"),
        cache_path: str("cache_path"),
        selected_path: str("selected_path"),
        verified: o.verified === true,
      };
      for (const k of [
        "requested_version",
        "resolved_version",
        "source_location",
        "integrity",
        "installed_at",
      ] as const) {
        if (str(k) !== "") sel[k] = str(k);
      }
      return sel;
    } catch {
      return undefined;
    }
  }

  private tryWriteLastError(languageID: string, operation: string, err: unknown): void {
    try {
      const langDir = join(this.baseDir, languageID);
      mkdirSync(langDir, { recursive: true, mode: 0o755 });
      const last: DependencyLastError = { operation, error: errorMessage(err) };
      writeFileSync(join(langDir, ".last-error.json"), goJSON(last), { mode: 0o644 });
    } catch {
      // Go discards the error
    }
  }

  private readLastError(languageID: string): DependencyLastError | undefined {
    try {
      const raw = JSON.parse(
        readFileSync(join(this.baseDir, languageID, ".last-error.json"), "utf8"),
      );
      if (raw === null || typeof raw !== "object") return undefined;
      const o = raw as Record<string, unknown>;
      return {
        operation: typeof o.operation === "string" ? o.operation : "",
        error: typeof o.error === "string" ? o.error : "",
      };
    } catch {
      return undefined;
    }
  }

  private tryClearLastError(languageID: string): void {
    try {
      unlinkSync(join(this.baseDir, languageID, ".last-error.json"));
    } catch {
      // missing is fine
    }
  }

  private cleanupEligible(languageID: string, selectedPath: string): boolean {
    if (selectedPath === "") return false;
    const selectedDir = this.selectedVersionDir(languageID, selectedPath);
    if (selectedDir === undefined) return false;
    try {
      for (const e of readdirSync(join(this.baseDir, languageID), { withFileTypes: true })) {
        if (e.isDirectory() && join(this.baseDir, languageID, e.name) !== selectedDir) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  private selectedVersionDir(languageID: string, selectedPath: string): string | undefined {
    const langDir = join(this.baseDir, languageID);
    const rel = relative(langDir, selectedPath);
    if (rel.startsWith("..") || rel === "" || rel === "." || isAbsolute(rel)) return undefined;
    const first = rel.split(sep)[0];
    if (first === undefined || first === "" || first === ".") return undefined;
    return join(langDir, first);
  }
}

// ---- pure helpers (exported for tests and the CLI) ----

export function validateInstallSelector(selector: InstallSelector): void {
  if (selector.latest && (selector.version ?? "").trim() !== "") {
    throw new Error("latest and explicit version selectors are mutually exclusive");
  }
}

export function requestedVersionForDependency(
  dep: RuntimeDependency,
  selector: InstallSelector,
): string {
  if (selector.latest) return "latest";
  const v = (selector.version ?? "").trim();
  if (v !== "") return v;
  if ((dep.recommended_version ?? "").trim() !== "") return "recommended";
  return "legacy-default";
}

function selectionSatisfiesRequest(
  selection: DependencySelection,
  dep: RuntimeDependency,
  selector: InstallSelector,
): boolean {
  if ((selection.requested_version ?? "") !== requestedVersionForDependency(dep, selector))
    return false;
  if (!selector.latest && (selector.version ?? "").trim() === "" && dep.recommended_version) {
    return (
      (selection.resolved_version ?? "") === dep.recommended_version &&
      (selection.integrity ?? "") === (dep.recommended_integrity ?? "") &&
      selection.verified
    );
  }
  return true;
}

export function resolveStaticDependency(
  dep: RuntimeDependency,
  selector: InstallSelector,
): DependencyResolution {
  const requested = requestedVersionForDependency(dep, selector);
  let resolved = (dep.version ?? "").trim();
  const selVersion = (selector.version ?? "").trim();
  if (dep.recommended_version && !selector.latest && selVersion === "") {
    resolved = dep.recommended_version;
  }
  if (selVersion !== "") {
    if (dep.recommended_version !== selVersion && dep.version !== selVersion) {
      throw new Error(
        `release version ${JSON.stringify(selVersion)} requires a dependency resolver`,
      );
    }
    resolved = selVersion;
  }
  if (selector.latest) throw new Error("latest release requires a dependency resolver");
  if (resolved === "") resolved = dependencyVersion(dep);
  const resolvedDep: RuntimeDependency = { ...dep, version: resolved };
  if (dep.url !== undefined) resolvedDep.url = expandVersionTemplate(dep.url, resolved);
  if (dep.extract_path !== undefined) {
    resolvedDep.extract_path = expandVersionTemplate(dep.extract_path, resolved);
  }
  return normalizeResolution(dep, selector, {
    dependency: resolvedDep,
    requested_version: requested,
    resolved_version: resolved,
    source: dependencySourceLocation(resolvedDep),
    integrity: dependencyIntegrity(resolvedDep),
    verified: !!dep.recommended_version && resolved === dep.recommended_version,
  });
}

export function parseNPMMetadata(data: string): [string, string] {
  const value: unknown = JSON.parse(data);
  return npmMetadataFromValue(value);
}

function npmMetadataFromValue(value: unknown): [string, string] {
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      const [v, integ] = npmMetadataFromValue(value[i]);
      if (v !== "" || integ !== "") return [v, integ];
    }
    return ["", ""];
  }
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const version = typeof o.version === "string" ? o.version : "";
    let integrity = typeof o["dist.integrity"] === "string" ? (o["dist.integrity"] as string) : "";
    if (integrity === "") {
      const dist = o.dist;
      if (dist !== null && typeof dist === "object") {
        const i = (dist as Record<string, unknown>).integrity;
        if (typeof i === "string") integrity = i;
      }
    }
    return [version, integrity];
  }
  return ["", ""];
}

export function normalizeResolution(
  original: RuntimeDependency,
  selector: InstallSelector,
  resolution: DependencyResolution,
): DependencyResolution {
  validateInstallSelector(selector);
  if (!resolution.dependency.binary_name) throw new Error("resolved dependency has no binary name");
  const out: DependencyResolution = {
    ...resolution,
    dependency: { ...resolution.dependency },
  };
  out.requested_version = requestedVersionForDependency(original, selector);
  if (out.resolved_version === "") out.resolved_version = dependencyVersion(out.dependency);
  out.dependency.version = out.resolved_version;
  if (out.source === "") out.source = dependencySourceLocation(out.dependency);
  out.verified = false;
  if (isNPMDependency(original)) {
    // npm's dist.integrity is an SRI value and therefore case-sensitive.
    out.verified =
      !!original.recommended_version &&
      !!original.recommended_integrity &&
      out.resolved_version === original.recommended_version &&
      out.integrity === original.recommended_integrity;
  } else {
    // Release provenance is the checksum the installer will actually use.
    out.integrity = dependencyIntegrity(out.dependency);
    out.verified =
      !!original.recommended_version &&
      !!original.recommended_integrity &&
      out.resolved_version === original.recommended_version &&
      (out.integrity ?? "").toLowerCase() === original.recommended_integrity.toLowerCase();
  }
  if (
    !selector.latest &&
    (selector.version ?? "").trim() === "" &&
    original.recommended_version &&
    !out.verified
  ) {
    if (!original.recommended_integrity) {
      throw new Error(
        `recommended version ${original.recommended_version} is missing pinned integrity metadata`,
      );
    }
    throw new Error(
      `recommended version ${original.recommended_version} integrity mismatch: expected ${original.recommended_integrity}, got ${out.integrity ?? ""}`,
    );
  }
  return out;
}

export function expandVersionTemplate(value: string, version: string): string {
  let v = value;
  for (const token of ["{{version}}", `$\u007bversion}`, "{version}"])
    v = v.replaceAll(token, version);
  return v;
}

export function dependencySourceLocation(dep: RuntimeDependency): string {
  if (dep.url) return dep.url;
  return npmPackages(dep).join(",");
}

export function dependencyIntegrity(dep: RuntimeDependency): string {
  if (dep.sha512 && dep.sha512.toLowerCase() !== "todo") return `sha512:${dep.sha512}`;
  if (dep.sha256 && dep.sha256.toLowerCase() !== "todo") return `sha256:${dep.sha256}`;
  return "";
}

/** dependencyBinaryPath with an explicit GOOS ("windows" selects .exe/.cmd). */
export function dependencyBinaryPath(
  versionDir: string,
  dep: RuntimeDependency,
  goos: string,
): string {
  if (isNPMDependency(dep)) {
    let name = dep.binary_name ?? "";
    if (goos === "windows") name += ".cmd";
    return join(versionDir, "node_modules", ".bin", name);
  }
  if (isNuGetDependency(dep)) {
    if (dep.extract_path) return join(versionDir, ...dep.extract_path.split("/"));
    return join(versionDir, dep.binary_name ?? "");
  }
  let p = join(versionDir, dep.binary_name ?? "");
  if (goos === "windows") p += ".exe";
  return p;
}

export function dependencyVersion(dep: RuntimeDependency): string {
  if (dep.version) return dep.version;
  if (dep.id) return dep.id;
  return "current";
}

export function dependencyVersionID(dep: RuntimeDependency): string {
  const version = dependencyVersion(dep);
  const normalized = version.replace(/[/\\:@]/g, "_");
  if (normalized === version) return normalized;
  const digest = createHash("sha256").update(version).digest("hex").slice(0, 12);
  return `${normalized}-${digest}`;
}

export function dependencyCacheName(dep: RuntimeDependency): string {
  if (isNuGetDependency(dep)) {
    if (dep.package_name) return dependencyVersionID({ id: dep.package_name });
    if (dep.id) return dependencyVersionID({ id: dep.id });
  }
  if (dep.binary_name) return dep.binary_name;
  if (dep.id) return dependencyVersionID({ id: dep.id });
  return "dependency";
}

export function dependencySource(dep: RuntimeDependency): string {
  if (dep.source) return dep.source;
  if (isNuGetDependency(dep)) return "nuget";
  if (isNPMDependency(dep)) return "npm";
  if (dep.archive_type === "binary") return "binary";
  if (dep.archive_type) return dep.archive_type;
  return "managed";
}

export function isNPMDependency(dep: RuntimeDependency): boolean {
  if (isNuGetDependency(dep)) return false;
  return (
    (dep.source ?? "").toLowerCase() === "npm" ||
    (dep.archive_type ?? "").toLowerCase() === "npm" ||
    !!dep.package_name ||
    (dep.packages?.length ?? 0) > 0
  );
}

export function isNuGetDependency(dep: RuntimeDependency): boolean {
  return (
    (dep.source ?? "").toLowerCase() === "nuget" ||
    (dep.archive_type ?? "").toLowerCase() === "nupkg"
  );
}

export function nugetPackageURL(dep: RuntimeDependency): string {
  const pkg = dep.package_name || dep.id || "";
  const version = dependencyVersion(dep);
  if (pkg === "" || version === "" || version === "current") return "";
  let base = (dep.package_source ?? "").replace(/\/+$/, "");
  if (base === "") base = "https://api.nuget.org/v3-flatcontainer";
  const lp = pkg.toLowerCase();
  const lv = version.toLowerCase();
  return `${base}/${lp}/${lv}/${lp}.${lv}.nupkg`;
}

export function npmPackages(dep: RuntimeDependency): string[] {
  if (dep.packages && dep.packages.length > 0) return [...dep.packages];
  if (dep.package_name) return [dep.package_name];
  if (dep.id) return [dep.id];
  return [dep.binary_name ?? ""];
}

export function npmPackageSpec(pkg: string, version: string): string {
  if (version === "" || version === "latest") return pkg;
  if (pkg.startsWith("@")) {
    if (pkg.lastIndexOf("@") > pkg.indexOf("/")) return pkg;
    return `${pkg}@${version}`;
  }
  if (pkg.includes("@")) return pkg;
  return `${pkg}@${version}`;
}

function pruneStatus(s: ManagedDependencyStatus): ManagedDependencyStatus {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (v === "" || v === undefined) continue;
    out[k] = v;
  }
  return out as unknown as ManagedDependencyStatus;
}

function rmQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // missing is fine
  }
}

/** json.MarshalIndent(v, "", "  ") including Go's HTML escaping of <, > and &. */
function goJSON(v: unknown): string {
  return JSON.stringify(v, null, 2)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

/** time.RFC3339Nano in UTC: fractional seconds without trailing zeros. */
function rfc3339Nano(d: Date): string {
  const iso = d.toISOString(); // 2026-01-02T03:04:05.678Z
  const [main, frac] = iso.replace("Z", "").split(".");
  const trimmed = (frac ?? "").replace(/0+$/, "");
  return trimmed === "" ? `${main}Z` : `${main}.${trimmed}Z`;
}

function decodeStdBase64(s: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return undefined;
  return Buffer.from(s, "base64");
}

// ---- minimal archive readers ----

interface TarEntry {
  name: string;
  data: Buffer;
}

function tarString(buf: Buffer, off: number, len: number): string {
  const slice = buf.subarray(off, off + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul < 0 ? slice.length : nul).toString("utf8");
}

function tarOctal(buf: Buffer, off: number, len: number): number {
  const s = tarString(buf, off, len).trim();
  return s === "" ? 0 : Number.parseInt(s, 8);
}

function paxPath(data: Buffer): string | undefined {
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    if (sp < 0) break;
    const len = Number.parseInt(data.subarray(pos, sp).toString("ascii"), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = data.subarray(sp + 1, pos + len - 1).toString("utf8");
    if (rec.startsWith("path=")) return rec.slice(5);
    pos += len;
  }
  return undefined;
}

function* readTar(tar: Buffer): Generator<TarEntry> {
  let pos = 0;
  let longName: string | undefined;
  let paxName: string | undefined;
  while (pos + 512 <= tar.length) {
    const header = tar.subarray(pos, pos + 512);
    if (header.every((b) => b === 0)) return;
    const size = tarOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    let name = tarString(header, 0, 100);
    const magic = tarString(header, 257, 6);
    if (magic.startsWith("ustar")) {
      const prefix = tarString(header, 345, 155);
      if (prefix !== "") name = `${prefix}/${name}`;
    }
    const data = tar.subarray(pos + 512, pos + 512 + size);
    pos += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = tarString(data, 0, data.length);
      continue;
    }
    if (type === "x") {
      paxName = paxPath(data);
      continue;
    }
    if (type === "g") continue;
    yield { name: paxName ?? longName ?? name, data: Buffer.from(data) };
    longName = undefined;
    paxName = undefined;
  }
}

interface ZipEntry {
  name: string;
  isDir: boolean;
  mode: number;
  read: () => Buffer;
}

function readZip(zip: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: not a valid zip file");
  const count = zip.readUInt16LE(eocd + 10);
  let pos = zip.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(pos) !== 0x02014b50) throw new Error("zip: invalid central directory");
    const madeBy = zip.readUInt16LE(pos + 4);
    const flags = zip.readUInt16LE(pos + 8);
    const method = zip.readUInt16LE(pos + 10);
    const compSize = zip.readUInt32LE(pos + 20);
    const nameLen = zip.readUInt16LE(pos + 28);
    const extraLen = zip.readUInt16LE(pos + 30);
    const commentLen = zip.readUInt16LE(pos + 32);
    const extAttr = zip.readUInt32LE(pos + 38);
    const localOff = zip.readUInt32LE(pos + 42);
    const name = zip
      .subarray(pos + 46, pos + 46 + nameLen)
      .toString(flags & 0x800 ? "utf8" : "latin1");
    pos += 46 + nameLen + extraLen + commentLen;
    const isDir = name.endsWith("/");
    // Go: unix creator host (3) carries the mode in the high 16 bits, otherwise MS-DOS defaults.
    let mode = madeBy >> 8 === 3 ? (extAttr >>> 16) & 0o777 : isDir ? 0o777 : 0o666;
    if (mode === 0) mode = isDir ? 0o755 : 0o644;
    entries.push({
      name,
      isDir,
      mode,
      read: () => {
        if (zip.readUInt32LE(localOff) !== 0x04034b50) throw new Error("zip: invalid local header");
        const lName = zip.readUInt16LE(localOff + 26);
        const lExtra = zip.readUInt16LE(localOff + 28);
        const start = localOff + 30 + lName + lExtra;
        const raw = zip.subarray(start, start + compSize);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return inflateRawSync(raw);
        throw new Error(`zip: unsupported compression algorithm ${method}`);
      },
    });
  }
  return entries;
}
