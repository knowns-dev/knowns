// Port of internal/lsp/manager.go: owns the language servers of one project root.
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { goLookPathError } from "../platform/goerror.ts";
import { selectBinaryCandidateOverride } from "./binary-override.ts";
import { capabilityProfileForAdapter } from "./capabilities.ts";
import type { Config } from "./config.ts";
import { type Ctx, withTimeout } from "./context.ts";
import {
  csharpBackendUnavailableError,
  csharpRoslynRuntimeDependency,
  discoverCSharpProject,
  resolveCSharpBackendWithOptions,
} from "./csharp.ts";
import { DependencyAdapter } from "./dependency-adapter.ts";
import { Detector, languageLogPath } from "./detect.ts";
import { EOF, ErrServerUnavailable, errorAs, errorIs, WrappedError } from "./errors.ts";
import { lookPath } from "./exec.ts";
import type { Installer } from "./installer.ts";
import { loadPluginAdapters, type PluginAdapterLoadError } from "./plugin-adapter.ts";
import { Registry } from "./registry.ts";
import { csharpLogPath, RuntimeError } from "./runtime-error.ts";
import { Server, TraceLogWriter } from "./server.ts";
import {
  applyRuntimeStatusOverlays,
  cloneLanguageRuntimeStatuses,
  collectRuntimeInventoryStatuses,
  type RuntimeStatusOptions,
  runtimeStatusCacheTTL,
} from "./status.ts";
import {
  type BinaryCandidate,
  CSharpBackendAuto,
  CSharpLanguageID,
  type InstallGuide,
  type InstallOptions,
  type LanguageAdapter,
  type LanguageInfo,
  type LanguageRuntimeStatus,
  type LogTail,
  type MissingServer,
  RuntimeInstallInstalled,
  RuntimeRunningRunning,
  type ServerCommand,
  type ServerStatus,
  type Session,
  StatusCrashed,
  StatusDisabled,
  StatusInstalled,
  StatusRunning,
  StatusStarting,
} from "./types.ts";

function warn(msg: string, fields: Record<string, unknown>): void {
  // slog.Warn writes to stderr; keep the key=value shape without the timestamp prefix.
  const kv = Object.entries(fields)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  process.stderr.write(`WARN ${msg} ${kv}\n`);
}

function primaryBinaryName(adapter: LanguageAdapter): string {
  const b = adapter.binaries();
  return b[0]?.name ?? adapter.name();
}

function pathCapabilityBlocksAll(adapter: LanguageAdapter | undefined, path: string): boolean {
  if (!adapter || typeof adapter.pathCapabilityForAction !== "function") return false;
  const [decision, handled] = adapter.pathCapabilityForAction(path, "", "");
  return handled && !decision.supported;
}

/** runtimeBinariesForAdapter: PATH candidates first, the managed install as fallback. */
export function runtimeBinariesForAdapter(
  adapter: LanguageAdapter | undefined,
  installer: Installer | undefined,
): BinaryCandidate[] {
  if (!adapter) return [];
  const binaries = [...adapter.binaries()];
  if (adapter.runtimeDeps().length === 0 || !installer) return binaries;
  const status = installer.status(adapter);
  if (status.installed && (status.selected_path ?? "") !== "") {
    return [...binaries, { name: status.selected_path as string, args: adapter.defaultArgs() }];
  }
  return binaries;
}

export function languageInfoFromRuntimeStatus(status: LanguageRuntimeStatus): LanguageInfo {
  const info: LanguageInfo = {
    id: status.id,
    name: status.name,
    enabled: status.enabled,
    detected: status.detected,
    status: status.status,
    binary: status.binary ?? "",
    binaryPath: status.binary_path,
    source: status.source,
    installed: status.install_state === RuntimeInstallInstalled,
    running: status.running_state === RuntimeRunningRunning,
    installState: status.install_state,
    runningState: status.running_state,
    readinessState: status.readiness_state,
    version: status.version,
    requestedVersion: status.requested_version,
    resolvedVersion: status.resolved_version,
    sourceLocation: status.source_location,
    integrity: status.integrity,
    installedAt: status.installed_at,
    verified: status.verified,
    cachePath: status.cache_path,
    selectedPath: status.selected_path,
    cleanupEligible: status.cleanup_eligible,
    installError: status.install_error,
    updateError: status.update_error,
    backend: status.backend,
    backendSource: status.backend_source,
    projectPath: status.project_path,
    projectKind: status.project_kind,
    logPath: status.log_path,
    attempts: status.attempts,
    owner: status.owner,
    daemonState: status.daemon_state,
    daemonPid: status.daemon_pid,
    daemonClients: status.daemon_clients,
    daemonTransport: status.daemon_transport,
    daemonEndpoint: status.daemon_endpoint,
    daemonIdleDeadline: status.daemon_idle_deadline,
    daemonLeaseCount: status.daemon_lease_count,
    daemonLeaseOwners: status.daemon_lease_owners ? [...status.daemon_lease_owners] : undefined,
    capabilitiesKnown: status.capabilities_known,
    capabilities: status.capabilities ? [...status.capabilities] : undefined,
    advertisedCapabilities: status.advertised_capabilities
      ? [...status.advertised_capabilities]
      : undefined,
    observedCapabilities: status.observed_capabilities
      ? [...status.observed_capabilities]
      : undefined,
    requiredCapabilities: status.required_capabilities
      ? [...status.required_capabilities]
      : undefined,
    missingCapabilities: status.missing_capabilities ? [...status.missing_capabilities] : undefined,
  };
  return info;
}

/** LanguageTraceLogPath: the stable JSON-RPC trace log path for a language runtime. */
export function languageTraceLogPath(root: string, languageID: string): string {
  if (root === "" || languageID === "") return "";
  return join(root, ".knowns", "logs", "lsp", `${languageID}.trace.log`);
}

export class Manager {
  private readonly root: string;
  private registry: Registry;
  private detector: Detector;
  private cfg: Config;

  private clients = 0;
  private servers = new Map<string, Server>();
  private adapters = new Map<string, LanguageAdapter>();
  private status = new Map<string, ServerStatus>();
  private traceEnabled = new Set<string>();

  private runtimeStatusCache: LanguageRuntimeStatus[] | undefined;
  private runtimeStatusCacheAt = 0;
  private runtimeStatusCacheGeneration = 0;
  private runtimeStatusLoading: Promise<void> | undefined;

  constructor(root: string, cfg: Config) {
    this.root = root;
    this.registry = Registry.empty();
    this.detector = new Detector(this.registry);
    this.cfg = cfg;
  }

  /** RegisterAdapter registers a language adapter with the manager. */
  registerAdapter(adapter: LanguageAdapter | null | undefined): void {
    if (!adapter) throw new Error("adapter is nil");
    if (adapter.id() === "") throw new Error("adapter id is required");
    this.registerAdapterLocked(adapter);
    this.invalidateRuntimeStatusCache();
  }

  registerPluginAdapters(opts: { dir?: string } = {}): PluginAdapterLoadError[] {
    const result = loadPluginAdapters(opts);
    const errs = [...result.errors];
    for (const adapter of result.adapters) {
      try {
        this.registerAdapter(adapter);
      } catch (e) {
        const path = typeof adapter.sourcePath === "function" ? adapter.sourcePath() : "";
        errs.push(
          Object.assign(e instanceof Error ? e : new Error(String(e)), {
            path,
          }) as unknown as PluginAdapterLoadError,
        );
      }
    }
    return errs;
  }

  setDetector(detector: Detector | null | undefined): void {
    if (detector) {
      this.detector = detector;
      this.invalidateRuntimeStatusCache();
    }
  }

  /** Config returns a snapshot of the manager's current LSP configuration. */
  config(): Config {
    return this.cfg.clone();
  }

  setConfig(cfg: Config): void {
    this.cfg = cfg.clone();
    this.invalidateRuntimeStatusCache();
  }

  /** ValidateBinaryOverride permits only binaries declared by the registered adapter. */
  validateBinaryOverride(langID: string, override: string): void {
    if (override === "") return;
    const adapter = this.adapters.get(langID);
    if (!adapter) throw new Error(`no adapter registered for language ${JSON.stringify(langID)}`);
    selectBinaryCandidateOverride(override, adapter.binaries());
  }

  async clientConnected(ctx: Ctx): Promise<void> {
    this.clients++;
    if (this.clients !== 1) return;
    try {
      await this.startDetected(ctx);
    } catch (e) {
      this.clients--;
      throw e;
    }
  }

  async clientDisconnected(ctx: Ctx): Promise<void> {
    if (this.clients > 0) this.clients--;
    if (this.clients !== 0) return;
    for (const srv of this.servers.values()) {
      try {
        await srv.stop(ctx);
      } catch {
        // ignored like Go
      }
    }
  }

  /** ServerForPath returns the started server owning path, or [undefined, false] when no language matches. */
  async serverForPath(ctx: Ctx, path: string): Promise<[Server | undefined, boolean]> {
    const lang = this.registry.forPath(path);
    if (!lang || !this.cfg.enabled(lang.id)) return [undefined, false];
    let srv = this.servers.get(lang.id);
    const status = this.status.get(lang.id) ?? 0;
    const adapter = this.adapters.get(lang.id);
    if (pathCapabilityBlocksAll(adapter, path)) {
      if (!srv) {
        const backend = adapter ? primaryBinaryName(adapter) : lang.name;
        srv = new Server(this.root, {
          language: lang.id,
          name: backend,
          backend,
          path: "",
          args: [],
        });
        this.configureServer(lang.id, srv);
      }
      return [srv, true];
    }

    // Auto-restart: if the server exists but is not alive, restart it transparently.
    if (srv && !srv.alive() && status !== StatusDisabled) {
      warn("lsp: server not alive, restarting", { language: lang.id });
      this.status.set(lang.id, StatusStarting);
      this.invalidateRuntimeStatusCache();
      try {
        await srv.start(ctx);
      } catch (e) {
        this.status.set(lang.id, StatusCrashed);
        this.invalidateRuntimeStatusCache();
        throw this.runtimeErrorForCommand(srv.command, e);
      }
      this.status.set(lang.id, StatusRunning);
      this.invalidateRuntimeStatusCache();
      return [srv, true];
    }

    if (srv) {
      try {
        await srv.start(ctx);
      } catch (e) {
        throw this.runtimeErrorForCommand(srv.command, e);
      }
      return [srv, true];
    }
    if (lang.id === CSharpLanguageID && this.cfg.binaryOverride(lang.id) === "") {
      const [cmd, ok] = await this.resolveCSharpCommand(ctx, false);
      if (!ok) return [undefined, false];
      srv = this.servers.get(lang.id);
      if (!srv) {
        srv = new Server(this.root, cmd);
        this.servers.set(lang.id, srv);
      } else {
        srv.command = cmd;
      }
      this.configureServer(lang.id, srv);
      this.invalidateRuntimeStatusCache();
      try {
        await srv.start(ctx);
      } catch (e) {
        throw this.runtimeErrorForCommand(cmd, e);
      }
      this.status.set(lang.id, StatusRunning);
      this.invalidateRuntimeStatusCache();
      return [srv, true];
    }
    const resolved = await this.resolveLanguageCommand(ctx, lang);
    if (!resolved) return [undefined, false];
    await this.startCommand(ctx, lang.id, resolved);
    srv = this.servers.get(lang.id);
    if (!srv) return [undefined, false];
    return [srv, true];
  }

  private async resolveLanguageCommand(
    ctx: Ctx,
    lang: import("./types.ts").Language,
  ): Promise<ServerCommand | undefined> {
    const cmd = await this.detector.resolve(ctx, this.root, lang, this.cfg.binaryOverride(lang.id));
    if (!cmd) return undefined;
    if (lang.id === CSharpLanguageID) {
      cmd.backend = this.cfg.backendOverride(lang.id) || "custom";
      cmd.projectPath = discoverCSharpProject(
        this.root,
        this.cfg.projectPathOverride(lang.id),
      ).path;
    }
    return cmd;
  }

  /** WithFile calls fn with the server for path while the file is synchronized. */
  async withFile(ctx: Ctx, path: string, fn: (srv: Server) => Promise<void>): Promise<void> {
    await this.withSession(ctx, path, async (session) => {
      if (!(session instanceof Server)) throw new Error("lsp session is not a server");
      await fn(session);
    });
  }

  /** WithSession starts the session for path, syncs the file during fn, and exposes only the Session surface. */
  async withSession(
    ctx: Ctx,
    path: string,
    fn: (session: Session) => Promise<void>,
  ): Promise<void> {
    const [srv, ok] = await this.serverForPath(ctx, path);
    if (!ok || !srv) throw this.unavailableReason(path);
    await srv.withFile(ctx, path, () => fn(srv));
  }

  private unavailableReason(path: string): Error {
    let info: ReturnType<typeof statSync> | undefined;
    let notExist = false;
    try {
      info = statSync(path);
    } catch (e) {
      notExist = (e as NodeJS.ErrnoException).code === "ENOENT";
    }
    if (info?.isDirectory()) {
      return new WrappedError(
        `${ErrServerUnavailable.message}: ${path} is a directory, and code intelligence operates on one source file at a time`,
        ErrServerUnavailable,
      );
    }
    if (notExist)
      return new WrappedError(
        `${ErrServerUnavailable.message}: ${path} does not exist`,
        ErrServerUnavailable,
      );

    const lang = this.registry.forPath(path);
    const known = lang !== undefined;
    const enabled = known && this.cfg.enabled(lang.id);
    if (known && !enabled) {
      return new WrappedError(
        `${ErrServerUnavailable.message}: ${lang.id} is registered but disabled for this project`,
        ErrServerUnavailable,
      );
    }
    if (!known) {
      const ext = extname(path);
      if (ext !== "") {
        return new WrappedError(
          `${ErrServerUnavailable.message}: no language server is registered for ${ext} files`,
          ErrServerUnavailable,
        );
      }
      return new WrappedError(
        `${ErrServerUnavailable.message}: ${basename(path)} has no file extension to match a language server`,
        ErrServerUnavailable,
      );
    }
    return ErrServerUnavailable;
  }

  /** WithAnyServer calls fn with any known server. Used for workspace-level queries. */
  async withAnyServer(_ctx: Ctx, fn: (srv: Server) => Promise<void>): Promise<void> {
    const first = this.servers.values().next();
    if (first.done || !first.value) throw new Error("no LSP server available");
    await fn(first.value);
  }

  /** StartAll starts all detected and adapter-registered servers in parallel (fail-open). */
  async startAll(ctx: Ctx): Promise<void> {
    const commands = await this.detector.detect(ctx, this.root, this.cfg);
    for (const cmd of commands) {
      const lang = this.registry.language(cmd.language);
      if (lang?.lazyStart) {
        if (!this.status.has(cmd.language)) this.status.set(cmd.language, StatusInstalled);
        continue;
      }
      if (!this.servers.has(cmd.language)) {
        const srv = new Server(this.root, cmd);
        this.configureTrace(cmd.language, srv);
        this.servers.set(cmd.language, srv);
      }
      this.configureServer(cmd.language, this.servers.get(cmd.language) as Server);
      if (!this.status.has(cmd.language)) this.status.set(cmd.language, StatusInstalled);
    }
    const items: { langID: string; srv: Server }[] = [];
    for (const [langID, srv] of this.servers) {
      if (this.registry.language(langID)?.lazyStart) continue;
      if ((this.status.get(langID) ?? 0) !== StatusDisabled) {
        this.configureTrace(langID, srv);
        items.push({ langID, srv });
        this.status.set(langID, StatusStarting);
      }
    }
    this.invalidateRuntimeStatusCache();
    await Promise.all(
      items.map(async ({ langID, srv }) => {
        const t = withTimeout(ctx, 15_000);
        try {
          await srv.start(t.ctx);
        } catch (e) {
          warn("lsp: failed to start server", {
            language: langID,
            error: e instanceof Error ? e.message : e,
          });
          this.status.set(langID, StatusCrashed);
          this.invalidateRuntimeStatusCache();
          return;
        } finally {
          t.cancel();
        }
        this.status.set(langID, StatusRunning);
        this.invalidateRuntimeStatusCache();
      }),
    );
  }

  async stopAll(ctx: Ctx): Promise<void> {
    for (const srv of [...this.servers.values()]) {
      try {
        await srv.stop(ctx);
      } catch {
        // ignored like Go
      }
    }
    for (const [langID, s] of this.status) {
      if (s === StatusRunning || s === StatusStarting) this.status.set(langID, StatusInstalled);
    }
    this.invalidateRuntimeStatusCache();
  }

  /** StartLanguage starts a single language server by adapter ID. */
  async startLanguage(ctx: Ctx, langID: string): Promise<void> {
    const adapter = this.adapters.get(langID);
    if (!adapter) throw new Error(`no adapter registered for language ${JSON.stringify(langID)}`);
    if (!this.cfg.enabled(langID))
      throw new Error(`language ${JSON.stringify(langID)} is disabled`);
    if (langID === CSharpLanguageID && this.cfg.binaryOverride(langID) === "") {
      const [cmd, ok] = await this.resolveCSharpCommand(ctx, true);
      if (!ok) return;
      await this.startCommand(ctx, langID, cmd);
      return;
    }
    const installer = this.installer();
    let binaries = runtimeBinariesForAdapter(adapter, installer);
    const override = this.cfg.binaryOverride(langID);
    if (override !== "") binaries = [selectBinaryCandidateOverride(override, adapter.binaries())];
    if (binaries.length === 0)
      throw new Error(`language ${JSON.stringify(langID)} has no binary candidates`);

    let lastErr: Error | undefined;
    for (const b of binaries) {
      const path = lookPath(b.name);
      if (path === undefined) {
        lastErr = new Error(`${b.name}: ${goLookPathError(b.name)}`);
        continue;
      }
      const cmd: ServerCommand = {
        language: langID,
        name: b.name,
        path,
        args: [...(b.args ?? [])],
        logPath: languageLogPath(this.root, langID),
      };
      await this.startCommand(ctx, langID, cmd);
      return;
    }
    throw lastErr ?? new Error("all binary candidates failed version check");
  }

  private async startCommand(ctx: Ctx, langID: string, cmd: ServerCommand): Promise<void> {
    let srv = this.servers.get(langID);
    if (!srv) {
      srv = new Server(this.root, cmd);
      this.servers.set(langID, srv);
    } else {
      srv.command = cmd;
    }
    this.configureServer(langID, srv);
    this.status.set(langID, StatusStarting);
    this.invalidateRuntimeStatusCache();

    const t = withTimeout(ctx, 15_000);
    try {
      await srv.start(t.ctx);
    } catch (e) {
      this.status.set(langID, StatusCrashed);
      this.invalidateRuntimeStatusCache();
      throw this.runtimeErrorForCommand(cmd, e);
    } finally {
      t.cancel();
    }
    this.status.set(langID, StatusRunning);
    this.invalidateRuntimeStatusCache();
  }

  private async resolveCSharpCommand(
    ctx: Ctx,
    autoInstall: boolean,
  ): Promise<[ServerCommand, boolean]> {
    const detector = this.detector;
    const [cmd, ok] = await resolveCSharpBackendWithOptions(ctx, this.root, this.cfg, {
      lookPath: detector.lookPath,
      runCheck: detector.runCheck,
      runCommand: detector.runCommand,
      installer: detector.installer,
      autoInstallRoslyn: autoInstall,
    });
    if (!ok) throw csharpBackendUnavailableError(this.root, cmd);
    return [cmd, true];
  }

  private runtimeErrorForCommand(cmd: ServerCommand, err: unknown): unknown {
    if (err === undefined || err === null || cmd.language !== CSharpLanguageID) return err;
    let code = "csharp_lsp_runtime_error";
    let message = "C# language server failed";
    const remediation =
      "Check the C# LSP log, run `knowns lsp install csharp`, and ensure .NET SDK 10+ is available.";
    if (errorIs(err, EOF)) {
      code = "csharp_lsp_eof";
      message = "C# language server closed the protocol stream before replying";
    }
    return new RuntimeError({
      code,
      language: CSharpLanguageID,
      backend: cmd.backend,
      message,
      remediation,
      logPath: cmd.logPath,
      attempts: cmd.attempts,
      cause: err,
    });
  }

  describeRuntimeError(path: string, err: unknown): RuntimeError | undefined {
    if (err === undefined || err === null) return undefined;
    const existing = errorAs(err, RuntimeError);
    if (existing) return existing;
    const lang = this.registry.forPath(path);
    let cmd: ServerCommand | undefined;
    if (lang) {
      const srv = this.servers.get(lang.id);
      if (srv) cmd = srv.command;
    }
    if (!lang || lang.id !== CSharpLanguageID) return undefined;
    if (!cmd || cmd.language === "") {
      const backend = this.cfg.backendOverride(CSharpLanguageID) || CSharpBackendAuto;
      cmd = {
        language: CSharpLanguageID,
        name: "",
        path: "",
        args: [],
        backend,
        logPath: csharpLogPath(this.root, backend),
      };
    }
    const wrapped = this.runtimeErrorForCommand(cmd, err);
    return errorAs(wrapped, RuntimeError);
  }

  /** RestartLanguage restarts the language server for langID through the shared runtime path. */
  async restartLanguage(ctx: Ctx, langID: string): Promise<void> {
    this.ensureAdapter(langID);
    if (!this.config().enabled(langID)) {
      try {
        await this.doStopLanguage(ctx, langID, StatusDisabled);
      } catch {
        // ignored like Go
      }
      throw new Error(`language ${JSON.stringify(langID)} is disabled`);
    }
    const t = withTimeout(ctx, 5000);
    try {
      await this.doStopLanguage(t.ctx, langID, StatusInstalled);
    } finally {
      t.cancel();
    }
    await this.startLanguage(ctx, langID);
  }

  /** StopLanguage gracefully stops the language server for langID. */
  async stopLanguage(langID: string): Promise<void> {
    const t = withTimeout(undefined, 5000);
    try {
      await this.doStopLanguage(t.ctx, langID, StatusDisabled);
    } finally {
      t.cancel();
    }
  }

  private async doStopLanguage(ctx: Ctx, langID: string, stopped: ServerStatus): Promise<void> {
    const srv = this.servers.get(langID);
    if (!srv) {
      if (this.status.has(langID)) {
        this.status.set(langID, stopped);
        this.invalidateRuntimeStatusCache();
      }
      return;
    }
    this.status.set(langID, stopped);
    this.invalidateRuntimeStatusCache();
    let err: unknown;
    try {
      await srv.stop(ctx);
    } catch (e) {
      err = e;
    }
    this.servers.delete(langID);
    this.status.set(langID, stopped);
    this.invalidateRuntimeStatusCache();
    if (err) throw err;
  }

  async installLanguage(ctx: Ctx, langID: string): Promise<string> {
    return this.installLanguageWithOptions(ctx, langID, { selector: {} });
  }

  async installLanguageWithOptions(
    ctx: Ctx,
    langID: string,
    opts: InstallOptions,
  ): Promise<string> {
    const adapter = this.adapters.get(langID);
    if (!adapter) throw new Error(`no adapter registered for language ${JSON.stringify(langID)}`);
    const cfg = this.cfg.clone();
    const installer = this.installer();
    let installAdapter: LanguageAdapter = adapter;
    if (langID === CSharpLanguageID) {
      installAdapter = new DependencyAdapter(CSharpLanguageID, [
        csharpRoslynRuntimeDependency(cfg),
      ]);
    }
    if (installAdapter.runtimeDeps().length > 0) {
      const callerBeforeCleanup = opts.beforeCleanup;
      const wrapped: InstallOptions = {
        ...opts,
        beforeCleanup: async (path: string) => {
          if (callerBeforeCleanup) await callerBeforeCleanup(path);
          this.refreshAdapterRegistration(langID);
        },
      };
      const path = await installer.installWithOptions(ctx, installAdapter, wrapped);
      this.invalidateRuntimeStatusCache();
      return path;
    }
    if (!adapter.canInstall())
      throw new Error(`language ${JSON.stringify(langID)} does not support managed install`);
    const path = await adapter.install(ctx, installer.baseDir);
    this.refreshAdapterRegistration(langID);
    this.invalidateRuntimeStatusCache();
    return path;
  }

  /** CleanupLanguage removes old managed runtime versions while preserving the selected one. */
  cleanupLanguage(langID: string): void {
    this.ensureAdapter(langID);
    this.installer().cleanup(langID);
    this.invalidateRuntimeStatusCache();
  }

  /** TailLog returns the last maxLines of a runtime or trace log; a missing file is an empty tail. */
  tailLog(langID: string, kind: string, maxLines: number): LogTail {
    let normalizedKind = kind.trim().toLowerCase();
    if (normalizedKind === "") normalizedKind = "runtime";
    if (normalizedKind !== "runtime" && normalizedKind !== "trace") {
      throw new Error(`unsupported log kind ${JSON.stringify(kind)}`);
    }
    const path = this.logPathForLanguageSync(langID, normalizedKind);
    let lines: string[];
    try {
      lines = tailLogFile(path, maxLines);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") lines = [];
      else throw e;
    }
    return { language: langID, kind: normalizedKind, path, lines };
  }

  /** SetTrace enables or disables JSON-RPC trace logging for an existing or future server. */
  setTrace(langID: string, enabled: boolean): string {
    if (!this.adapters.has(langID))
      throw new Error(`no adapter registered for language ${JSON.stringify(langID)}`);
    const path = languageTraceLogPath(this.root, langID);
    if (enabled) touchLogFile(path);
    if (enabled) this.traceEnabled.add(langID);
    else this.traceEnabled.delete(langID);
    const srv = this.servers.get(langID);
    if (srv) this.configureTrace(langID, srv);
    return path;
  }

  /** AvailableLanguages returns all registered adapters with their install and running status. */
  async availableLanguages(ctx?: Ctx): Promise<LanguageInfo[]> {
    const statuses = await this.runtimeStatuses(ctx);
    return statuses.map((status) => {
      const info = languageInfoFromRuntimeStatus(status);
      info.traceEnabled = this.traceEnabled.has(status.id) || undefined;
      if (status.install_state !== RuntimeInstallInstalled) info.installHint = status.install_cmd;
      return info;
    });
  }

  /** RuntimeStatuses returns manager-backed runtime status, including live process and readiness state. */
  async runtimeStatuses(ctx?: Ctx): Promise<LanguageRuntimeStatus[]> {
    const [inventory, opts] = await this.runtimeStatusInventory(ctx);
    return applyRuntimeStatusOverlays(inventory, opts);
  }

  private async runtimeStatusInventory(
    ctx: Ctx,
  ): Promise<[LanguageRuntimeStatus[], RuntimeStatusOptions]> {
    for (;;) {
      const opts = this.runtimeStatusOptions();
      if (this.runtimeStatusCacheFresh(performance.now())) {
        return [
          cloneLanguageRuntimeStatuses(this.runtimeStatusCache as LanguageRuntimeStatus[]),
          opts,
        ];
      }
      if (this.runtimeStatusLoading) {
        await this.runtimeStatusLoading;
        continue;
      }
      const generation = this.runtimeStatusCacheGeneration;
      let done: () => void = () => {};
      this.runtimeStatusLoading = new Promise<void>((r) => {
        done = r;
      });
      let inventory: LanguageRuntimeStatus[];
      try {
        inventory = await collectRuntimeInventoryStatuses(ctx, opts);
      } finally {
        this.runtimeStatusLoading = undefined;
        done();
      }
      const cacheable = !ctx?.aborted;
      if (cacheable && generation === this.runtimeStatusCacheGeneration) {
        this.runtimeStatusCache = cloneLanguageRuntimeStatuses(inventory);
        this.runtimeStatusCacheAt = performance.now();
        return [cloneLanguageRuntimeStatuses(inventory), this.runtimeStatusOptions()];
      }
      if (ctx?.aborted)
        return [cloneLanguageRuntimeStatuses(inventory), this.runtimeStatusOptions()];
    }
  }

  private runtimeStatusOptions(): RuntimeStatusOptions {
    return {
      root: this.root,
      config: this.cfg.clone(),
      adapters: [...this.adapters.values()],
      detector: this.detector,
      installer: this.installer(),
      status: new Map(this.status),
      servers: new Map(this.servers),
    };
  }

  private runtimeStatusCacheFresh(now: number): boolean {
    return (
      this.runtimeStatusCache !== undefined &&
      this.runtimeStatusCache.length > 0 &&
      this.runtimeStatusCacheAt !== 0 &&
      now - this.runtimeStatusCacheAt < runtimeStatusCacheTTL
    );
  }

  private invalidateRuntimeStatusCache(): void {
    this.runtimeStatusCache = undefined;
    this.runtimeStatusCacheAt = 0;
    this.runtimeStatusCacheGeneration++;
  }

  private registerAdapterLocked(adapter: LanguageAdapter): void {
    const binaries = runtimeBinariesForAdapter(adapter, this.installer()).map((b) => ({
      name: b.name,
      args: b.args,
      checkArgs: b.check_args,
    }));
    const matchers =
      typeof adapter.pathMatchers === "function" ? adapter.pathMatchers() : undefined;
    const lazyStart = typeof adapter.lazyStart === "function" ? adapter.lazyStart() : false;
    this.registry.register({
      id: adapter.id(),
      name: adapter.name(),
      extensions: adapter.extensions(),
      binaries,
      matchers,
      lazyStart,
    });
    this.adapters.set(adapter.id(), adapter);
  }

  private refreshAdapterRegistration(langID: string): void {
    const adapter = this.adapters.get(langID);
    if (adapter) {
      this.registerAdapterLocked(adapter);
      this.invalidateRuntimeStatusCache();
    }
  }

  /** MissingServers returns detected languages that have no available binary. */
  async missingServers(ctx?: Ctx): Promise<MissingServer[]> {
    const languages = this.detector.detectedLanguages(this.root, this.cfg);
    const missing: MissingServer[] = [];
    for (const lang of languages) {
      const adapter = this.adapters.get(lang.id);
      if (!adapter) continue;
      const st = this.status.get(lang.id);
      if (st === StatusRunning || st === StatusInstalled || st === StatusStarting) continue;
      if (await this.detector.resolve(ctx, this.root, lang, this.cfg.binaryOverride(lang.id)))
        continue;
      const guide: InstallGuide = adapter.installGuide();
      missing.push({
        languageID: lang.id,
        name: adapter.name(),
        binaryName: primaryBinaryName(adapter),
        guide,
      });
    }
    return missing;
  }

  /** ActiveLanguages returns languages with running servers. */
  activeLanguages(): string[] {
    const out: string[] = [];
    for (const [language, srv] of this.servers) if (srv.alive()) out.push(language);
    return out;
  }

  private ensureAdapter(langID: string): void {
    if (!this.adapters.has(langID))
      throw new Error(`no adapter registered for language ${JSON.stringify(langID)}`);
  }

  private installer(): Installer {
    return this.detector.installer as Installer;
  }

  private configureTrace(langID: string, srv: Server): void {
    srv.traceWriter = this.traceEnabled.has(langID)
      ? new TraceLogWriter(languageTraceLogPath(this.root, langID))
      : undefined;
  }

  private configureServer(langID: string, srv: Server): void {
    const adapter = this.adapters.get(langID);
    if (!adapter) srv.setInitializeParams(undefined);
    else
      srv.setInitializeParams(
        adapter.initializeParams(this.root, this.cfg.languageSettings(langID)),
      );
    if (adapter) srv.setCapabilityProfile(capabilityProfileForAdapter(adapter));
    srv.setDocumentSyncAdapter(langID, adapter);
    srv.setPathCapabilityAdapter(adapter);
    this.configureTrace(langID, srv);
  }

  private logPathForLanguageSync(langID: string, kind: string): string {
    if (!this.adapters.has(langID))
      throw new Error(`no adapter registered for language ${JSON.stringify(langID)}`);
    if (kind === "trace") return languageTraceLogPath(this.root, langID);
    const srv = this.servers.get(langID);
    if (srv?.command.logPath) return srv.command.logPath;
    const cached = this.runtimeStatusCache?.find((s) => s.id === langID);
    if (cached?.log_path) return cached.log_path;
    return languageLogPath(this.root, langID);
  }

  /** LogPathForLanguage: like Go it consults live runtime statuses before the default. */
  async logPathForLanguage(langID: string, kind: string): Promise<string> {
    if (!this.adapters.has(langID))
      throw new Error(`no adapter registered for language ${JSON.stringify(langID)}`);
    if (kind === "trace") return languageTraceLogPath(this.root, langID);
    const srv = this.servers.get(langID);
    if (srv?.command.logPath) return srv.command.logPath;
    for (const status of await this.runtimeStatuses()) {
      if (status.id === langID && status.log_path) return status.log_path;
    }
    return languageLogPath(this.root, langID);
  }

  private async startDetected(ctx: Ctx): Promise<void> {
    const commands = await this.detector.detect(ctx, this.root, this.cfg);
    const servers: Server[] = [];
    for (const cmd of commands) {
      const lang = this.registry.language(cmd.language);
      if (lang?.lazyStart) {
        if (!this.status.has(cmd.language)) this.status.set(cmd.language, StatusInstalled);
        continue;
      }
      let srv = this.servers.get(cmd.language);
      if (!srv) {
        srv = new Server(this.root, cmd);
        this.servers.set(cmd.language, srv);
      }
      this.configureServer(cmd.language, srv);
      servers.push(srv);
    }
    for (const srv of servers) await srv.start(ctx);
  }
}

export function tailLogFile(path: string, maxLinesIn: number): string[] {
  let maxLines = maxLinesIn;
  if (maxLines <= 0) maxLines = 200;
  if (maxLines > 5000) maxLines = 5000;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return [];
    const chunkSize = 32 * 1024;
    const chunks: Buffer[] = [];
    let newlineCount = 0;
    for (let offset = size; offset > 0 && newlineCount <= maxLines; ) {
      const readSize = Math.min(chunkSize, offset);
      offset -= readSize;
      const buf = Buffer.alloc(readSize);
      readSync(fd, buf, 0, readSize, offset);
      for (const b of buf) if (b === 0x0a) newlineCount++;
      chunks.push(buf);
    }
    const data = Buffer.concat(chunks.reverse());
    const text = data.toString("utf8").replaceAll("\r\n", "\n").replace(/\n+$/, "");
    if (text === "") return [];
    const lines = text.split("\n");
    return lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
  } finally {
    closeSync(fd);
  }
}

export function touchLogFile(path: string): void {
  if (path === "") throw new Error("log path is empty");
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, "", { mode: 0o644 });
}
