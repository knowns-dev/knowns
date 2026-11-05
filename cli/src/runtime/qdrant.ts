// Port of internal/qdrantruntime (manager.go, ensure.go): the managed local Qdrant process under
// ~/.knowns/runtime/qdrant, enough for the runtime queue (EnsureRunning before every job that talks
// to Qdrant) and `search index` (start after an install check). The artifact installer
// (installer.go: pinned download, checksum, archive extraction) is not part of this port: an
// installed binary and a matching install.json are honoured, anything else fails with Go's
// not-installed error.

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  SEMANTIC_VECTOR_BACKEND_QDRANT,
  SEMANTIC_VECTOR_STORE_MODE_EXTERNAL,
  SEMANTIC_VECTOR_STORE_MODE_MANAGED,
  type SemanticVectorStoreResolution,
} from "../models/config.ts";
import { goJson } from "../search/json.ts";
import { goTimeString } from "../search/time.ts";
import { globalRootPath } from "../storage/core/global-root.ts";
import { isProcessAlive, nowString, sleep } from "./queue.ts";

export const DEFAULT_HTTP_PORT = 6333;
export const DEFAULT_GRPC_PORT = 6334;

export const QDRANT_STATUS_RUNNING = "running";
export const QDRANT_STATUS_STOPPED = "stopped";
export const QDRANT_STATUS_STALE = "stale";
export const QDRANT_STATUS_EXTERNAL = "external";
export const QDRANT_STATUS_DISABLED = "disabled";
export const QDRANT_STATUS_NOT_INSTALLED = "not-installed";

export const SUPPORTED_QDRANT_VERSION = "1.14.1";

export class WedgedProcessStoppedError extends Error {
  override readonly name = "WedgedProcessStoppedError";
  constructor(detail: string) {
    super(`managed Qdrant was running but unhealthy and has been stopped: ${detail}`);
  }
}

export interface QdrantRuntimeConfig {
  enabled: boolean;
  backend: string;
  mode: string;
  root: string;
  externalURL: string;
  binaryPath: string;
  httpPort: number;
  grpcPort: number;
}

export interface QdrantPaths {
  root: string;
  binDir: string;
  binaryPath: string;
  dataDir: string;
  logsDir: string;
  logPath: string;
  pidPath: string;
  statusPath: string;
  snapshotsDir: string;
}

export interface QdrantRuntimeStatus {
  enabled: boolean;
  backend: string;
  mode: string;
  managed: boolean;
  state: string;
  running: boolean;
  installed: boolean;
  pid?: number;
  endpoint?: string;
  externalURL?: string;
  message?: string;
  paths: QdrantPaths;
  updatedAt: string;
}

export interface ProcessController {
  start(binary: string, env: Record<string, string>, logFd: number): number;
  stop(pid: number, timeoutMs: number): Promise<void>;
  alive(pid: number): boolean;
}

export const defaultProcessController: ProcessController = {
  start(binary, env, logFd) {
    const child = spawn(binary, [], {
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
    if (child.pid === undefined) throw new Error("start qdrant: no pid");
    return child.pid;
  },
  async stop(pid, timeoutMs) {
    if (pid <= 0) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) return;
      await sleep(100);
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  },
  alive: isProcessAlive,
};

export function defaultRoot(): string {
  return join(globalRootPath(), "runtime", "qdrant");
}

export function expandPath(path: string): string {
  const p = path.trim();
  if (p === "") return "";
  if (p === "~" || p.startsWith("~/")) {
    const home = dirname(globalRootPath());
    return p === "~" ? home : join(home, p.slice(2));
  }
  return p;
}

export function pathsForRoot(rootIn: string): QdrantPaths {
  let root = expandPath(rootIn);
  if (root === "") root = defaultRoot();
  const binDir = join(root, "bin");
  return {
    root,
    binDir,
    binaryPath: join(binDir, process.platform === "win32" ? "qdrant.exe" : "qdrant"),
    dataDir: join(root, "data"),
    logsDir: join(root, "logs"),
    logPath: join(root, "logs", "qdrant.log"),
    pidPath: join(root, "qdrant.pid"),
    statusPath: join(root, "status.json"),
    snapshotsDir: join(root, "snapshots"),
  };
}

export function configFromResolution(res: SemanticVectorStoreResolution): QdrantRuntimeConfig {
  return {
    enabled: res.enabled,
    backend: res.backend,
    mode: res.mode,
    root: res.managedRoot !== "" ? expandPath(res.managedRoot) : defaultRoot(),
    externalURL: res.externalURL,
    binaryPath: "",
    httpPort: DEFAULT_HTTP_PORT,
    grpcPort: DEFAULT_GRPC_PORT,
  };
}

function managedEndpoint(port: number): string {
  return `http://127.0.0.1:${port || DEFAULT_HTTP_PORT}`;
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function firstNonEmpty(...values: string[]): string {
  for (const v of values) if (v.trim() !== "") return v;
  return "";
}

function sanitizedEndpoint(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, u.pathname === "/" ? "" : "/");
  } catch {
    return "invalid-external-endpoint";
  }
}

const ensureCache = new Map<string, { at: number; err: Error | undefined }>();
export const ensureWindows = { success: 15_000, failure: 5_000 };

export function resetEnsureCache(): void {
  ensureCache.clear();
}

export class QdrantManager {
  readonly config: QdrantRuntimeConfig;
  controller: ProcessController = defaultProcessController;
  now: () => number = Date.now;
  healthCheck: (endpoint: string, signal: AbortSignal) => Promise<void> = defaultHealthCheck;
  readinessTimeoutMs = 20_000;

  constructor(cfg: Partial<QdrantRuntimeConfig> = {}) {
    this.config = {
      enabled: cfg.enabled ?? true,
      backend: cfg.backend || SEMANTIC_VECTOR_BACKEND_QDRANT,
      mode: cfg.mode || SEMANTIC_VECTOR_STORE_MODE_MANAGED,
      root: cfg.root || defaultRoot(),
      externalURL: cfg.externalURL ?? "",
      binaryPath: cfg.binaryPath ?? "",
      httpPort: cfg.httpPort || DEFAULT_HTTP_PORT,
      grpcPort: cfg.grpcPort || DEFAULT_GRPC_PORT,
    };
  }

  paths(): QdrantPaths {
    const paths = pathsForRoot(this.config.root);
    if (this.config.binaryPath !== "") {
      paths.binaryPath = expandPath(this.config.binaryPath);
      paths.binDir = dirname(paths.binaryPath);
    }
    return paths;
  }

  isExternal(): boolean {
    return (
      this.config.mode === SEMANTIC_VECTOR_STORE_MODE_EXTERNAL ||
      this.config.externalURL.trim() !== ""
    );
  }

  ownsManagedProcess(): boolean {
    return (
      this.config.enabled &&
      this.config.backend === SEMANTIC_VECTOR_BACKEND_QDRANT &&
      this.config.mode === SEMANTIC_VECTOR_STORE_MODE_MANAGED &&
      !this.isExternal()
    );
  }

  ensureDirs(): void {
    const p = this.paths();
    for (const dir of [p.root, p.binDir, p.dataDir, p.logsDir, p.snapshotsDir]) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o755 });
      } catch (err) {
        throw new Error(`create qdrant runtime dir ${dir}: ${(err as Error).message}`);
      }
    }
  }

  status(message = ""): QdrantRuntimeStatus {
    const paths = this.paths();
    const status: QdrantRuntimeStatus = {
      enabled: this.config.enabled,
      backend: this.config.backend,
      mode: this.config.mode,
      managed: !this.isExternal(),
      state: "",
      running: false,
      installed: false,
      endpoint: managedEndpoint(this.config.httpPort),
      message,
      paths,
      updatedAt: nowString(this.now()),
    };
    if (!this.config.enabled || this.config.backend !== SEMANTIC_VECTOR_BACKEND_QDRANT) {
      status.state = QDRANT_STATUS_DISABLED;
      status.message = firstNonEmpty(message, "semantic Qdrant backend is disabled");
      return status;
    }
    if (this.isExternal()) {
      status.managed = false;
      status.state = QDRANT_STATUS_EXTERNAL;
      status.externalURL = sanitizedEndpoint(this.config.externalURL);
      status.endpoint = status.externalURL;
      status.installed = true;
      status.message = firstNonEmpty(
        message,
        "external Qdrant URL configured; managed process ownership disabled",
      );
      return status;
    }
    status.installed = fileExists(paths.binaryPath);
    const pid = readPidFile(paths.pidPath);
    if (pid !== undefined) {
      status.pid = pid;
      status.running = this.controller.alive(pid);
      if (status.running) status.state = QDRANT_STATUS_RUNNING;
      else {
        status.state = QDRANT_STATUS_STALE;
        status.message = firstNonEmpty(message, "managed Qdrant pid file is stale");
      }
    } else if (!status.installed) {
      status.state = QDRANT_STATUS_NOT_INSTALLED;
      status.message = firstNonEmpty(message, "managed Qdrant binary is not installed");
    } else {
      status.state = QDRANT_STATUS_STOPPED;
    }
    return status;
  }

  writeStatus(status: QdrantRuntimeStatus): void {
    mkdirSync(dirname(status.paths.statusPath), { recursive: true, mode: 0o755 });
    writeFileSync(status.paths.statusPath, `${goJson(statusJson(status), { indent: 2 })}\n`, {
      mode: 0o644,
    });
  }

  private async waitForReady(endpoint: string): Promise<void> {
    const timeout = this.readinessTimeoutMs > 0 ? this.readinessTimeoutMs : 20_000;
    const deadline = Date.now() + timeout;
    let lastErr: unknown;
    for (;;) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), Math.max(1, deadline - Date.now()));
      try {
        await this.healthCheck(endpoint, ac.signal);
        return;
      } catch (err) {
        lastErr = err;
      } finally {
        clearTimeout(timer);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `readiness timeout: context deadline exceeded (last error: ${(lastErr as Error)?.message})`,
        );
      }
      await sleep(100);
    }
  }

  /** Start starts managed Qdrant if needed. External mode is a visible no-op. */
  async start(): Promise<QdrantRuntimeStatus> {
    if (this.isExternal()) {
      const status = this.status("external Qdrant URL configured; managed process start bypassed");
      try {
        this.writeStatus(status);
      } catch {
        // best effort
      }
      return status;
    }
    if (!this.config.enabled || this.config.backend !== SEMANTIC_VECTOR_BACKEND_QDRANT) {
      const status = this.status("semantic Qdrant backend is disabled");
      try {
        this.writeStatus(status);
      } catch {
        // best effort
      }
      return status;
    }
    this.ensureDirs();
    let status = this.status("");
    if (status.running) {
      try {
        await this.waitForReady(status.endpoint ?? "");
        status.message = "managed Qdrant already running and healthy";
        this.writeStatus(status);
        return status;
      } catch (err) {
        await this.controller.stop(status.pid ?? 0, 10_000);
        rmSync(status.paths.pidPath, { force: true });
        status.running = false;
        status.pid = undefined;
        status.state = QDRANT_STATUS_STOPPED;
        status.message =
          "managed Qdrant process was running but failed HTTP readiness; inspect logs: knowns qdrant logs";
        try {
          this.writeStatus(status);
        } catch {
          // best effort
        }
        throw new WedgedProcessStoppedError(
          `${(err as Error).message}; inspect ${status.paths.logPath} or run \`knowns qdrant logs\``,
        );
      }
    }
    if (!status.installed) {
      status.state = QDRANT_STATUS_NOT_INSTALLED;
      status.message =
        "managed Qdrant binary not installed; run an explicit install/repair command";
      try {
        this.writeStatus(status);
      } catch {
        // best effort
      }
      throw new Error(`managed Qdrant binary not found at ${status.paths.binaryPath}`);
    }
    let logFd: number;
    try {
      logFd = openSync(status.paths.logPath, "a", 0o644);
    } catch (err) {
      throw new Error(`open qdrant log: ${(err as Error).message}`);
    }
    let pid: number;
    try {
      pid = this.controller.start(status.paths.binaryPath, this.processEnv(status.paths), logFd);
    } finally {
      closeSync(logFd);
    }
    try {
      writeFileSync(status.paths.pidPath, String(pid), { mode: 0o644 });
    } catch (err) {
      await this.controller.stop(pid, 10_000);
      throw new Error(`write qdrant pid: ${(err as Error).message}`);
    }
    try {
      await this.waitForReady(managedEndpoint(this.config.httpPort));
    } catch (err) {
      await this.controller.stop(pid, 10_000);
      rmSync(status.paths.pidPath, { force: true });
      status = this.status(
        "managed Qdrant failed HTTP readiness; inspect logs: knowns qdrant logs",
      );
      status.running = false;
      status.pid = undefined;
      status.state = QDRANT_STATUS_STOPPED;
      try {
        this.writeStatus(status);
      } catch {
        // best effort
      }
      throw new Error(
        `wait for Qdrant /healthz: ${(err as Error).message}; inspect ${status.paths.logPath} or run \`knowns qdrant logs\``,
      );
    }
    status = this.status("managed Qdrant started");
    status.pid = pid;
    status.running = true;
    status.state = QDRANT_STATUS_RUNNING;
    this.writeStatus(status);
    return status;
  }

  /** EnsureRunning: start managed Qdrant when this configuration owns one and it is not serving. */
  async ensureRunning(): Promise<void> {
    if (!this.ownsManagedProcess()) return;
    const key = this.paths().root;
    const now = this.now();
    const cached = ensureCache.get(key);
    if (cached) {
      const window = cached.err ? ensureWindows.failure : ensureWindows.success;
      if (now - cached.at < window) {
        if (cached.err) throw cached.err;
        return;
      }
    }
    let err: Error | undefined;
    try {
      try {
        await this.start();
      } catch (e) {
        if (e instanceof WedgedProcessStoppedError) await this.start();
        else throw e;
      }
    } catch (e) {
      err = e as Error;
    }
    ensureCache.set(key, { at: now, err });
    if (err) throw err;
  }

  private processEnv(paths: QdrantPaths): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.QDRANT__STORAGE__STORAGE_PATH = paths.dataDir;
    env.QDRANT__STORAGE__SNAPSHOTS_PATH = paths.snapshotsDir;
    env.QDRANT__SERVICE__HOST = "127.0.0.1";
    env.QDRANT__SERVICE__HTTP_PORT = String(this.config.httpPort);
    env.QDRANT__SERVICE__GRPC_PORT = String(this.config.grpcPort);
    env.QDRANT__TELEMETRY_DISABLED = "true";
    return env;
  }
}

function readPidFile(path: string): number | undefined {
  try {
    const text = readFileSync(path, "utf8").trim();
    if (!/^[+-]?\d+$/.test(text)) return undefined;
    const pid = Number(text);
    return pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function defaultHealthCheck(endpoint: string, signal: AbortSignal): Promise<void> {
  const resp = await fetch(`${endpoint.replace(/\/+$/, "")}/healthz`, { signal });
  if (resp.status !== 200)
    throw new Error(`GET /healthz returned ${resp.status} ${resp.statusText}`);
}

function statusJson(s: QdrantRuntimeStatus): unknown {
  return {
    enabled: s.enabled,
    backend: s.backend,
    mode: s.mode,
    managed: s.managed,
    state: s.state,
    running: s.running,
    installed: s.installed,
    ...(s.pid ? { pid: s.pid } : {}),
    ...(s.endpoint ? { endpoint: s.endpoint } : {}),
    ...(s.externalURL ? { externalURL: s.externalURL } : {}),
    ...(s.message ? { message: s.message } : {}),
    paths: s.paths,
    updatedAt: goTimeString(s.updatedAt),
  };
}

/** Installer.Install, without the network leg: an installed, matching binary is accepted. */
export function installQdrant(root: string): QdrantPaths {
  const paths = pathsForRoot(root);
  mkdirSync(paths.root, { recursive: true, mode: 0o755 });
  const manifestPath = join(paths.root, "install.json");
  if (existsSync(manifestPath) && fileExists(paths.binaryPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: string };
      if (m.version === SUPPORTED_QDRANT_VERSION) return paths;
    } catch {
      // fall through
    }
  }
  if (fileExists(paths.binaryPath)) return paths;
  throw new Error(
    `Qdrant ${SUPPORTED_QDRANT_VERSION} is not installed at ${paths.binaryPath}; the TypeScript build cannot download it yet`,
  );
}

export function ensureManagedQdrant(res: SemanticVectorStoreResolution): Promise<void> {
  return new QdrantManager(configFromResolution(res)).ensureRunning();
}
