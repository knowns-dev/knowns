// Port of internal/lsp/status.go: the canonical per-language runtime snapshot.
import { basename, isAbsolute, join } from "node:path";
import { selectBinaryCandidateOverride } from "./binary-override.ts";
import {
  capabilityProfileForAdapter,
  missingCapabilities,
  newCapabilitySnapshot,
  normalizeCapabilities,
} from "./capabilities.ts";
import type { Config } from "./config.ts";
import { type Ctx, withTimeout } from "./context.ts";
import {
  csharpProjectKind,
  csharpRoslynRuntimeDependency,
  discoverCSharpProject,
  resolveCSharpBackendWithOptions,
} from "./csharp.ts";
import { discoverDartProject, parseDartSDKVersion } from "./dart.ts";
import { DependencyAdapter, defaultLSPBaseDir } from "./dependency-adapter.ts";
import { Detector, languageLogPath } from "./detect.ts";
import type { LookPath, RunCheck, RunCommand } from "./exec.ts";
import { Installer } from "./installer.ts";
import { Registry } from "./registry.ts";
import { csharpLogPath } from "./runtime-error.ts";
import type { Server } from "./server.ts";
import {
  type BackendAttempt,
  BackendAttemptFailed,
  type CapabilityProfile,
  CSharpBackendAuto,
  CSharpBackendRoslyn,
  CSharpLanguageID,
  DartLanguageID,
  type LanguageAdapter,
  type LanguageRuntimeStatus,
  type ManagedDependencyStatus,
  type PathMatcher,
  RuntimeInstallDisabled,
  RuntimeInstallError,
  RuntimeInstallInstalled,
  RuntimeInstallNotInstalled,
  RuntimeReadinessIndexing,
  RuntimeReadinessNotApplicable,
  RuntimeReadinessUnknown,
  RuntimeRunningCrashed,
  RuntimeRunningDisabled,
  RuntimeRunningRunning,
  RuntimeRunningStarting,
  RuntimeRunningStopped,
  RuntimeRunningUnknown,
  RuntimeSourceAuto,
  RuntimeSourceConfig,
  RuntimeSourceKnowns,
  RuntimeSourcePATH,
  RuntimeStatusDegraded,
  type ServerStatus,
  StatusCrashed,
  StatusDisabled,
  StatusInstalled,
  StatusNotInstalled,
  StatusRunning,
  StatusStarting,
} from "./types.ts";

export const runtimeStatusProbeTimeout = 2000;
export const runtimeStatusCacheTTL = 30_000;

export interface RuntimeStatusOptions {
  root: string;
  config: Config;
  adapters: LanguageAdapter[];
  detector?: Detector;
  installer?: Installer;
  status?: Map<string, ServerStatus>;
  servers?: Map<string, Server>;
}

/** LanguageRuntimeStatus with the zero values Go's `omitempty` would drop removed, in Go field order. */
export function runtimeStatusJSON(s: LanguageRuntimeStatus): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (k: string, v: unknown, omitEmpty = true): void => {
    if (omitEmpty) {
      if (v === undefined || v === "" || v === 0 || v === false) return;
      if (Array.isArray(v) && v.length === 0) return;
    }
    out[k] = v;
  };
  put("id", s.id, false);
  put("name", s.name, false);
  put("enabled", s.enabled, false);
  put("detected", s.detected, false);
  put("status", s.status, false);
  put("install_state", s.install_state, false);
  put("running_state", s.running_state, false);
  put("readiness_state", s.readiness_state, false);
  put("binary", s.binary);
  put("binary_path", s.binary_path);
  put("source", s.source);
  put("version", s.version);
  put("requested_version", s.requested_version);
  put("resolved_version", s.resolved_version);
  put("source_location", s.source_location);
  put("integrity", s.integrity);
  put("installed_at", s.installed_at);
  put("verified", s.verified === true, false);
  put("cache_path", s.cache_path);
  put("selected_path", s.selected_path);
  put("cleanup_eligible", s.cleanup_eligible);
  put("install_error", s.install_error);
  put("update_error", s.update_error);
  put("install_cmd", s.install_cmd);
  put("backend", s.backend);
  put("backend_source", s.backend_source);
  put("project_path", s.project_path);
  put("project_kind", s.project_kind);
  put("log_path", s.log_path);
  put("attempts", s.attempts);
  put("owner", s.owner);
  put("daemon_state", s.daemon_state);
  put("daemon_pid", s.daemon_pid);
  put("daemon_clients", s.daemon_clients);
  put("daemon_transport", s.daemon_transport);
  put("daemon_endpoint", s.daemon_endpoint);
  put("daemon_idle_deadline", s.daemon_idle_deadline);
  put("daemon_lease_count", s.daemon_lease_count);
  put("daemon_lease_owners", s.daemon_lease_owners);
  put("capabilities_known", s.capabilities_known);
  put("capabilities", s.capabilities);
  put("advertised_capabilities", s.advertised_capabilities);
  put("observed_capabilities", s.observed_capabilities);
  put("required_capabilities", s.required_capabilities);
  put("missing_capabilities", s.missing_capabilities);
  return out;
}

export function cloneLanguageRuntimeStatuses(
  statuses: LanguageRuntimeStatus[],
): LanguageRuntimeStatus[] {
  return statuses.map((s) => structuredClone(s));
}

function installCommand(languageID: string): string {
  return languageID === "" ? "" : `knowns lsp install ${languageID}`;
}

function binarySource(override: string): string {
  return override !== "" ? RuntimeSourceConfig : RuntimeSourcePATH;
}

export function normalizeBinaryVersion(output: string): string {
  let line = output.trim();
  const idx = line.indexOf("\n");
  if (idx >= 0) line = line.slice(0, idx).trim();
  return line;
}

function firstAttemptReason(attempts: BackendAttempt[]): string {
  for (const a of attempts)
    if (a.status === BackendAttemptFailed && (a.reason ?? "") !== "") return a.reason as string;
  return "";
}

/** CollectRuntimeStatuses returns status for adapters without starting servers or installing dependencies. */
export async function collectRuntimeStatuses(
  ctx: Ctx,
  opts: RuntimeStatusOptions,
): Promise<LanguageRuntimeStatus[]> {
  const statuses = await collectRuntimeInventoryStatuses(ctx, opts);
  return applyRuntimeStatusOverlays(statuses, opts);
}

export async function collectRuntimeInventoryStatuses(
  ctx: Ctx,
  opts: RuntimeStatusOptions,
): Promise<LanguageRuntimeStatus[]> {
  const detector = opts.detector ?? new Detector(null);
  const lookPath = detector.lookPath;
  const runCheck = detector.runCheck;
  const runCommand = detector.runCommand;
  const installer = opts.installer ?? detector.installer ?? new Installer(defaultLSPBaseDir());

  const detected = detectedRuntimeLanguages(opts.root, opts.config, opts.adapters, detector);
  const statuses: LanguageRuntimeStatus[] = [];
  for (const adapter of opts.adapters) {
    const langID = adapter.id();
    const status: LanguageRuntimeStatus = {
      id: langID,
      name: adapter.name(),
      enabled: opts.config.enabled(langID),
      detected: detected.has(langID),
      status: RuntimeInstallNotInstalled,
      install_state: RuntimeInstallNotInstalled,
      running_state: RuntimeRunningUnknown,
      readiness_state: RuntimeReadinessNotApplicable,
      verified: false,
    };
    const guide = adapter.installGuide();
    if (guide.knowns_cmd) status.install_cmd = guide.knowns_cmd;
    else if (guide.command) status.install_cmd = guide.command;
    else if (adapter.canInstall()) status.install_cmd = installCommand(langID);

    applyExpectedBackendStatus(status, adapter, opts.config.binaryOverride(langID));
    applyManagedStatus(status, adapter, opts.config, installer);
    await applyBinaryStatus(
      ctx,
      status,
      adapter,
      opts.config.binaryOverride(langID),
      lookPath,
      runCheck,
      runCommand,
    );
    if (langID === CSharpLanguageID) {
      await applyCSharpStatus(ctx, status, opts, lookPath, runCheck, runCommand, installer);
    } else if (langID === DartLanguageID) {
      await applyDartStatus(ctx, status, opts, runCommand);
    } else {
      status.log_path = languageLogPath(opts.root, langID);
    }
    statuses.push(status);
  }
  statuses.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return statuses;
}

export function applyRuntimeStatusOverlays(
  statuses: LanguageRuntimeStatus[],
  opts: RuntimeStatusOptions,
): LanguageRuntimeStatus[] {
  const profileByLanguage = new Map<string, CapabilityProfile>();
  for (const adapter of opts.adapters)
    profileByLanguage.set(adapter.id(), capabilityProfileForAdapter(adapter));
  for (const s of statuses) {
    applyLiveStatus(s, opts.status?.get(s.id) ?? StatusNotInstalled, opts.servers?.get(s.id));
    applyCapabilityStatus(
      s,
      profileByLanguage.get(s.id) ?? { required: [] },
      opts.servers?.get(s.id),
    );
    finalizeRuntimeStatus(s);
  }
  statuses.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return statuses;
}

function applyExpectedBackendStatus(
  status: LanguageRuntimeStatus,
  adapter: LanguageAdapter,
  override: string,
): void {
  const backend = override.trim();
  if (backend !== "") {
    status.backend = basename(backend);
    status.backend_source = RuntimeSourceConfig;
    return;
  }
  const binaries = adapter.binaries();
  const first = binaries[0];
  if (!first) return;
  status.backend = basename(first.name);
  status.backend_source = RuntimeSourceAuto;
}

function detectedRuntimeLanguages(
  root: string,
  cfg: Config,
  adapters: LanguageAdapter[],
  detector: Detector | undefined,
): Set<string> {
  const seen = new Set<string>();
  if (root === "") return seen;
  const registry = Registry.empty();
  const tryRegister = (lang: Parameters<Registry["register"]>[0]): void => {
    try {
      registry.register(lang);
    } catch {
      // Go: _ = registry.Register(...)
    }
  };
  for (const adapter of adapters) {
    let matchers: PathMatcher[] | undefined;
    if (typeof adapter.pathMatchers === "function") matchers = adapter.pathMatchers();
    tryRegister({
      id: adapter.id(),
      name: adapter.name(),
      extensions: adapter.extensions(),
      matchers,
    });
  }
  if (detector?.registry) {
    for (const lang of detector.registry.languages()) {
      if (registry.language(lang.id)) continue;
      tryRegister(lang);
    }
  }
  const d = new Detector(registry);
  for (const lang of d.detectedLanguages(root, cfg)) seen.add(lang.id);
  return seen;
}

export function managedStatusForAdapter(
  adapter: LanguageAdapter,
  cfg: Config,
  installer: Installer,
): ManagedDependencyStatus {
  if (adapter.id() === CSharpLanguageID) {
    return installer.status(
      new DependencyAdapter(CSharpLanguageID, [csharpRoslynRuntimeDependency(cfg)]),
    );
  }
  return installer.status(adapter);
}

function applyManagedStatus(
  status: LanguageRuntimeStatus,
  adapter: LanguageAdapter,
  cfg: Config,
  installer: Installer,
): void {
  if (adapter.id() !== CSharpLanguageID && adapter.runtimeDeps().length === 0) return;
  const managed = managedStatusForAdapter(adapter, cfg, installer);
  status.version = managed.version;
  status.requested_version = managed.requested_version;
  status.resolved_version = managed.resolved_version;
  status.source_location = managed.source_location;
  status.integrity = managed.integrity;
  status.installed_at = managed.installed_at;
  status.verified = managed.verified;
  status.cache_path = managed.cache_path;
  status.selected_path = managed.selected_path;
  status.cleanup_eligible = managed.cleanup_eligible;
  status.install_error = managed.install_error;
  status.update_error = managed.update_error;
  if (managed.installed) {
    status.install_state = RuntimeInstallInstalled;
    status.source = RuntimeSourceKnowns;
    status.binary_path = managed.selected_path;
    status.binary = basename(managed.selected_path ?? "");
  }
  if (!managed.installed && (managed.install_error ?? "") !== "")
    status.install_state = RuntimeInstallError;
}

export async function resolveAdapterBinary(
  ctx: Ctx,
  adapter: LanguageAdapter,
  override: string,
  lookPath: LookPath,
  runCheck: RunCheck | undefined,
  runCommand: RunCommand | undefined,
): Promise<[string, string, string, boolean]> {
  let binaries = adapter.binaries();
  if (override !== "") {
    try {
      binaries = [selectBinaryCandidateOverride(override, binaries)];
    } catch {
      return ["", "", "", false];
    }
  }
  for (const candidate of binaries) {
    const path = lookPath(candidate.name);
    if (path === undefined) continue;
    const checkArgs = candidate.check_args ?? [];
    if (runCheck && checkArgs.length > 0) {
      const t = withTimeout(ctx, runtimeStatusProbeTimeout);
      try {
        await runCheck(t.ctx, path, ...checkArgs);
      } catch {
        continue;
      } finally {
        t.cancel();
      }
    }
    let version = "";
    if (runCommand && checkArgs.length > 0) {
      const t = withTimeout(ctx, runtimeStatusProbeTimeout);
      try {
        version = normalizeBinaryVersion(await runCommand(t.ctx, path, ...checkArgs));
      } catch {
        // version stays empty
      } finally {
        t.cancel();
      }
    }
    let binary = candidate.name;
    if (isAbsolute(binary)) binary = basename(binary);
    return [binary, path, version, true];
  }
  return ["", "", "", false];
}

async function applyBinaryStatus(
  ctx: Ctx,
  status: LanguageRuntimeStatus,
  adapter: LanguageAdapter,
  override: string,
  lookPath: LookPath,
  runCheck: RunCheck | undefined,
  runCommand: RunCommand | undefined,
): Promise<void> {
  const [binary, path, version, ok] = await resolveAdapterBinary(
    ctx,
    adapter,
    override,
    lookPath,
    runCheck,
    runCommand,
  );
  if (!ok) return;
  status.install_state = RuntimeInstallInstalled;
  status.binary = binary;
  status.binary_path = path;
  status.source = binarySource(override);
  status.backend = binary;
  status.backend_source = override !== "" ? RuntimeSourceConfig : RuntimeSourceAuto;
  if (version !== "") status.version = version;
}

async function applyCSharpStatus(
  ctx: Ctx,
  status: LanguageRuntimeStatus,
  opts: RuntimeStatusOptions,
  lookPath: LookPath,
  runCheck: RunCheck | undefined,
  runCommand: RunCommand | undefined,
  installer: Installer,
): Promise<void> {
  const selection = discoverCSharpProject(
    opts.root,
    opts.config.projectPathOverride(CSharpLanguageID),
  );
  status.project_path = selection.path;
  status.project_kind = selection.kind;

  let configuredBackend = opts.config.backendOverride(CSharpLanguageID);
  if (configuredBackend === "") configuredBackend = CSharpBackendAuto;
  status.backend = configuredBackend;
  status.backend_source =
    configuredBackend !== CSharpBackendAuto ? RuntimeSourceConfig : RuntimeSourceAuto;
  status.log_path = csharpLogPath(opts.root, configuredBackend);

  if (opts.config.binaryOverride(CSharpLanguageID) !== "") {
    if (status.backend === CSharpBackendAuto) status.backend = "custom";
    status.backend_source = RuntimeSourceConfig;
    return;
  }

  const [cmd, ok] = await resolveCSharpBackendWithOptions(ctx, opts.root, opts.config, {
    lookPath,
    runCheck,
    runCommand,
    installer,
    autoInstallRoslyn: false,
  });
  status.attempts = [...(cmd.attempts ?? [])];
  if (cmd.projectPath) {
    status.project_path = cmd.projectPath;
    status.project_kind = csharpProjectKind(cmd.projectPath);
  }
  if (cmd.logPath) status.log_path = cmd.logPath;
  if (cmd.backend) status.backend = cmd.backend;
  if (!ok) {
    status.install_state = RuntimeInstallError;
    if ((status.install_error ?? "") === "")
      status.install_error = firstAttemptReason(cmd.attempts ?? []);
    return;
  }
  status.install_state = RuntimeInstallInstalled;
  status.binary = cmd.name;
  status.binary_path = cmd.path;
  status.source =
    cmd.backend === CSharpBackendRoslyn && (status.selected_path ?? "") !== ""
      ? RuntimeSourceKnowns
      : RuntimeSourcePATH;
}

async function applyDartStatus(
  ctx: Ctx,
  status: LanguageRuntimeStatus,
  opts: RuntimeStatusOptions,
  runCommand: RunCommand | undefined,
): Promise<void> {
  status.log_path = languageLogPath(opts.root, DartLanguageID);
  const selection = discoverDartProject(opts.root);
  status.project_path = selection.path;
  status.project_kind = selection.kind;
  if ((status.binary_path ?? "") === "" || !runCommand) return;
  const t = withTimeout(ctx, runtimeStatusProbeTimeout);
  try {
    const output = await runCommand(t.ctx, status.binary_path as string, "--version");
    const version = parseDartSDKVersion(output);
    if (version !== "") status.version = version;
  } catch {
    // Go returns on error without touching the version.
  } finally {
    t.cancel();
  }
}

function applyLiveStatus(
  status: LanguageRuntimeStatus,
  lifecycle: ServerStatus,
  server: Server | undefined,
): void {
  if (lifecycle === 0 && !server) return;
  switch (lifecycle) {
    case StatusDisabled:
      status.running_state = RuntimeRunningDisabled;
      break;
    case StatusStarting:
      status.running_state = RuntimeRunningStarting;
      break;
    case StatusRunning:
      status.running_state = RuntimeRunningRunning;
      break;
    case StatusCrashed:
      status.running_state = RuntimeRunningCrashed;
      break;
    case StatusInstalled:
    case StatusNotInstalled:
      status.running_state = RuntimeRunningStopped;
      break;
  }
  if (server) {
    if (server.alive()) {
      status.running_state = RuntimeRunningRunning;
      status.readiness_state = server.readinessState();
    } else if (status.running_state === RuntimeRunningRunning) {
      status.running_state = RuntimeRunningCrashed;
    }
    if (server.command.logPath) status.log_path = server.command.logPath;
  }
}

function applyCapabilityStatus(
  status: LanguageRuntimeStatus,
  profile: CapabilityProfile,
  server: Server | undefined,
): void {
  status.required_capabilities = normalizeCapabilities(profile.required);
  if (!server) return;
  const rt = server.capabilitySnapshot();
  const snapshot = newCapabilitySnapshot(
    rt.known,
    rt.advertised_capabilities,
    rt.observed_capabilities,
  );
  status.capabilities_known = snapshot.known;
  status.capabilities = [...snapshot.capabilities];
  status.advertised_capabilities = [...snapshot.advertised_capabilities];
  status.observed_capabilities = [...snapshot.observed_capabilities];
  if (snapshot.known)
    status.missing_capabilities = missingCapabilities(
      status.required_capabilities,
      snapshot.capabilities,
    );
}

function finalizeRuntimeStatus(status: LanguageRuntimeStatus): void {
  if (!status.enabled) {
    status.status = RuntimeInstallDisabled;
    status.install_state = RuntimeInstallDisabled;
    status.running_state = RuntimeRunningDisabled;
    status.readiness_state = RuntimeReadinessNotApplicable;
    return;
  }
  status.status =
    status.install_state === RuntimeInstallInstalled
      ? RuntimeInstallInstalled
      : RuntimeInstallNotInstalled;
  switch (status.running_state) {
    case RuntimeRunningRunning:
      status.status = RuntimeRunningRunning;
      if (
        status.readiness_state === "" ||
        status.readiness_state === RuntimeReadinessNotApplicable
      ) {
        status.readiness_state = RuntimeReadinessUnknown;
      }
      break;
    case RuntimeRunningStarting:
      status.status = RuntimeRunningStarting;
      status.readiness_state = RuntimeReadinessIndexing;
      break;
    case RuntimeRunningCrashed:
      status.status = RuntimeRunningCrashed;
      status.readiness_state = RuntimeReadinessUnknown;
      break;
    default:
      if (status.detected && status.install_state === RuntimeInstallInstalled) {
        status.readiness_state = RuntimeReadinessUnknown;
      }
      if (status.running_state === "") status.running_state = RuntimeRunningUnknown;
  }
  if (
    status.running_state === RuntimeRunningRunning &&
    status.capabilities_known &&
    (status.missing_capabilities?.length ?? 0) > 0
  ) {
    status.status = RuntimeStatusDegraded;
  }
}

export { join as _join };
