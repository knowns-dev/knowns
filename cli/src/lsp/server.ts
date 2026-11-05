// Port of internal/lsp/server.go, capabilities.go (Server methods) and queries.go (Server methods).
// One Server owns one language-server child process and speaks JSON-RPC over its stdio.
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { goFsError } from "../platform/goerror.ts";
import {
  hasCapability,
  newCapabilitySnapshot,
  normalizeCapabilities,
  normalizeInitializeCapabilities,
} from "./capabilities.ts";
import { type Ctx, ctxErr, raceAbort } from "./context.ts";
import { EOF, WrappedError } from "./errors.ts";
import { FileSync } from "./filesync.ts";
import { columnForLine } from "./queries.ts";
import { RuntimeError } from "./runtime-error.ts";
import {
  CapabilityDefinition,
  CapabilityDiagnostics,
  CapabilityDocumentSymbols,
  CapabilityImplementation,
  type CapabilityProfile,
  CapabilityReferences,
  CapabilityRename,
  type CapabilitySnapshot,
  CapabilityWorkspaceSymbols,
  type Diagnostic,
  type DocumentSymbol,
  type DocumentSyncOptions,
  type LanguageAdapter,
  type Location,
  type PathCapabilityDecision,
  type Range,
  RuntimeReadinessIndexing,
  RuntimeReadinessNotApplicable,
  RuntimeReadinessReady,
  type ServerCommand,
  type Session,
  type WorkspaceEdit,
  type WorkspaceSymbolResult,
} from "./types.ts";
import { fileURI, sameFileURI } from "./uri.ts";

export interface Writer {
  write(chunk: string | Uint8Array): void;
}

type PathDocumentSync = Pick<LanguageAdapter, "documentSyncForPath">;
type PathCapability = Pick<LanguageAdapter, "pathCapabilityForAction">;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

const legacyDiagnosticSettleDelay = 400;

function emptyRange(r: Range): boolean {
  return r.start.line === 0 && r.start.character === 0 && r.end.line === 0 && r.end.character === 0;
}

function cloneDiagnostics(d: Diagnostic[] | undefined): Diagnostic[] | undefined {
  return d ? d.map((x) => ({ ...x })) : undefined;
}

function serverRequestResult(method: string): unknown {
  if (method === "workspace/configuration") return [];
  return null;
}

function quoteCmdArg(a: string): string {
  if (a !== "" && !/[\s"&|<>^()%!]/.test(a)) return a;
  return `"${a.replaceAll('"', '""')}"`;
}

export class Server implements Session {
  command: ServerCommand;
  readonly root: string;
  logWriter: Writer | undefined;
  traceWriter: Writer | undefined;

  private child: ChildProcess | undefined;
  private logFd: number | undefined;
  private running = false;
  private initialized = false;
  private exited: Promise<void> | undefined;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private buf: Buffer = Buffer.alloc(0);
  private files: FileSync;
  private diagnosticsByURI = new Map<string, Diagnostic[]>();
  private diagnosticResultIDs = new Map<string, string>();
  private readyFlag = false;
  private readyResolve: () => void = () => {};
  private readyPromise: Promise<void>;
  private startChain: Promise<void> = Promise.resolve();

  private capabilitiesKnown = false;
  private advertisedCapabilities: string[] = [];
  private observedCapabilities = new Set<string>();
  private capProfile: CapabilityProfile = { required: [] };
  private initParams: Record<string, unknown> | undefined;
  private documentSyncLanguageID: string;
  private documentSyncAdapter: PathDocumentSync | undefined;
  private pathCapabilityAdapter: PathCapability | undefined;

  constructor(root: string, command: ServerCommand) {
    this.root = root;
    this.command = command;
    this.documentSyncLanguageID = command.language;
    this.readyPromise = new Promise<void>((r) => {
      this.readyResolve = () => {
        this.readyFlag = true;
        r();
      };
    });
    this.files = new FileSync(
      (p) => this.didOpen(p),
      (p) => this.didClose(p),
    );
  }

  // ---- lifecycle ----

  /** WaitReady blocks until indexing completes or ctx is cancelled (3s fallback after start). */
  async waitReady(ctx: Ctx): Promise<void> {
    try {
      await raceAbort(ctx, this.readyPromise);
    } catch {
      // Go: select on ctx.Done() returns without an error.
    }
  }

  readinessState(): string {
    if (!this.alive()) return RuntimeReadinessNotApplicable;
    return this.readyFlag ? RuntimeReadinessReady : RuntimeReadinessIndexing;
  }

  alive(): boolean {
    return this.running;
  }

  start(ctx: Ctx): Promise<void> {
    const run = this.startChain.then(() => this.startLocked(ctx));
    this.startChain = run.catch(() => {});
    return run;
  }

  private async startLocked(ctx: Ctx): Promise<void> {
    if (this.running) return;
    const staleExited = this.child ? this.exited : undefined;
    if (staleExited) await raceAbort(ctx, staleExited);
    this.files.reset();
    this.clearCapabilities();
    this.clearDiagnostics();
    this.buf = Buffer.alloc(0);

    let stderrTarget: "inherit" | number | "pipe";
    if (this.logWriter) {
      stderrTarget = "pipe";
    } else if (this.command.logPath) {
      mkdirSync(dirname(this.command.logPath), { recursive: true });
      this.logFd = openSync(this.command.logPath, "a", 0o644);
      stderrTarget = this.logFd;
    } else {
      stderrTarget = "inherit";
    }

    let child: ChildProcess;
    try {
      child = this.spawnChild(stderrTarget);
    } catch (e) {
      this.closeLogFd();
      throw e;
    }
    // spawn failures (ENOENT) arrive as an 'error' event; surface them as the Start error.
    const spawnError = new Promise<never>((_, reject) => {
      child.once("error", (err) => reject(err));
    });
    spawnError.catch(() => {});
    this.child = child;
    this.running = true;
    let exitedResolve: () => void = () => {};
    this.exited = new Promise<void>((r) => {
      exitedResolve = r;
    });
    const exited = this.exited;

    child.stdout?.on("data", (d: Buffer) => this.onData(child, d));
    if (this.logWriter) {
      const w = this.logWriter;
      child.stderr?.on("data", (d: Buffer) => w.write(d));
    }
    child.stdin?.on("error", () => {});
    child.once("close", () => {
      if (this.child === child) {
        this.closeLogFd();
        this.running = false;
        this.initialized = false;
        this.clearCapabilities();
        this.clearDiagnostics();
        this.child = undefined;
        this.failPending(EOF);
      }
      exitedResolve();
    });
    child.once("error", () => {
      // Never launched: the 'close' event may not fire; settle the same way.
      if (this.child === child) {
        this.closeLogFd();
        this.running = false;
        this.initialized = false;
        this.child = undefined;
        this.failPending(EOF);
      }
      exitedResolve();
    });

    let startupComplete = false;
    const onAbort = () => {
      if (!startupComplete) child.kill();
    };
    ctx?.addEventListener("abort", onAbort, { once: true });
    const cleanupFailed = async (err: unknown): Promise<never> => {
      const ce = ctxErr(ctx);
      const e = ce ?? err;
      child.kill();
      await exited;
      if (this.child === child) {
        this.closeLogFd();
        this.child = undefined;
        this.running = false;
        this.initialized = false;
        this.clearCapabilities();
      }
      throw e;
    };
    try {
      try {
        await Promise.race([this.initialize(ctx), spawnError]);
      } catch (e) {
        return await cleanupFailed(e);
      }
      try {
        this.notify("initialized", {});
      } catch (e) {
        return await cleanupFailed(e);
      }
      startupComplete = true;
      this.initialized = true;
    } finally {
      ctx?.removeEventListener("abort", onAbort);
    }
    const timer = setTimeout(() => this.readyResolve(), 3000);
    (timer as { unref?: () => void }).unref?.();
  }

  private spawnChild(stderrTarget: "inherit" | number | "pipe"): ChildProcess {
    const stdio: ("pipe" | "inherit" | number)[] = ["pipe", "pipe", stderrTarget];
    let file = this.command.path;
    let args = this.command.args;
    const opts = { cwd: this.root, stdio, windowsHide: true } as {
      cwd: string;
      stdio: ("pipe" | "inherit" | number)[];
      windowsHide: boolean;
      windowsVerbatimArguments?: boolean;
    };
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
      // Windows refuses to run batch shims directly; route through cmd.exe like Go's CreateProcess does.
      const line = [file, ...args].map(quoteCmdArg).join(" ");
      file = process.env.ComSpec ?? "cmd.exe";
      args = ["/d", "/s", "/c", `"${line}"`];
      opts.windowsVerbatimArguments = true;
    }
    return spawn(file, args, opts);
  }

  private closeLogFd(): void {
    if (this.logFd !== undefined) {
      try {
        closeSync(this.logFd);
      } catch {
        // already closed
      }
      this.logFd = undefined;
    }
  }

  async stop(ctx: Ctx): Promise<void> {
    try {
      await this.files.closeAll();
    } catch {
      // Go: _ = s.files.CloseAll()
    }
    if (!this.running || !this.child) return;
    const child = this.child;
    const exited = this.exited;
    try {
      await this.shutdown(ctx);
    } catch {
      // ignored like Go
    }
    try {
      this.notify("exit", null);
    } catch {
      // ignored
    }
    this.running = false;
    this.initialized = false;
    this.clearCapabilities();
    this.clearDiagnostics();
    this.child = undefined;
    this.failPending(EOF);
    this.closeLogFd();
    if (!exited) return;
    try {
      await raceAbort(ctx, exited);
    } catch (e) {
      child.kill();
      await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 2000))]);
      throw e;
    }
  }

  // ---- document sync ----

  async withFile(ctx: Ctx, path: string, fn: () => Promise<void>): Promise<void> {
    if (this.pathCapabilityBlocksAll(path)) {
      if (fn) await fn();
      return;
    }
    await this.start(ctx);
    await this.files.open(path);
    try {
      if (fn) await fn();
    } finally {
      await this.files.close(path);
    }
  }

  private async didOpen(path: string): Promise<void> {
    const sync = this.documentSyncForPath(path);
    if (sync.suppress) return;
    this.requireInitialized();
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      throw goFsError("open", path, e);
    }
    this.notify("textDocument/didOpen", {
      textDocument: { uri: fileURI(path), languageId: sync.languageID, version: 1, text },
    });
  }

  async didChange(_ctx: Ctx, path: string, text: string): Promise<void> {
    if (this.documentSyncForPath(path).suppress) return;
    this.requireInitialized();
    this.notify("textDocument/didChange", {
      textDocument: { uri: fileURI(path), version: 2 },
      contentChanges: [{ text }],
    });
  }

  private async didClose(path: string): Promise<void> {
    if (this.documentSyncForPath(path).suppress) return;
    this.requireInitialized();
    this.notify("textDocument/didClose", { textDocument: { uri: fileURI(path) } });
  }

  setDocumentSyncAdapter(languageID: string, adapter: PathDocumentSync | undefined): void {
    this.documentSyncLanguageID = languageID;
    this.documentSyncAdapter = adapter?.documentSyncForPath ? adapter : undefined;
  }

  setPathCapabilityAdapter(adapter: PathCapability | undefined): void {
    this.pathCapabilityAdapter = adapter?.pathCapabilityForAction ? adapter : undefined;
  }

  setInitializeParams(params: Record<string, unknown> | undefined): void {
    this.initParams = params ? { ...params } : undefined;
  }

  private documentSyncForPath(path: string): DocumentSyncOptions {
    let options: DocumentSyncOptions = { languageID: this.documentSyncLanguageID, suppress: false };
    const a = this.documentSyncAdapter;
    if (a?.documentSyncForPath) {
      options = a.documentSyncForPath(path);
      if (options.languageID === "")
        options = { ...options, languageID: this.documentSyncLanguageID };
    }
    return options;
  }

  // ---- capabilities ----

  setCapabilityProfile(profile: CapabilityProfile): void {
    this.capProfile = { ...profile, required: normalizeCapabilities(profile.required) };
  }

  capabilitySnapshot(): Required<CapabilitySnapshot> {
    return newCapabilitySnapshot(this.capabilitiesKnown, this.advertisedCapabilities, [
      ...this.observedCapabilities,
    ]);
  }

  private clearCapabilities(): void {
    this.capabilitiesKnown = false;
    this.advertisedCapabilities = [];
    this.observedCapabilities = new Set();
  }

  private observeCapability(capability: string): void {
    const c = capability.trim().toLowerCase();
    if (c !== "") this.observedCapabilities.add(c);
  }

  private capabilityBackend(): string {
    let backend = (this.command.backend ?? "").trim();
    if (backend === "") backend = this.command.name.trim();
    return backend;
  }

  private unsupportedCapabilityError(
    action: string,
    explanation: string,
    capabilities: string[],
    advertised: string[],
  ): RuntimeError {
    return new RuntimeError({
      code: "unsupported_capability",
      language: this.command.language,
      backend: this.capabilityBackend(),
      action,
      message: `LSP action "${action}" is unavailable`,
      explanation,
      capabilities: normalizeCapabilities(capabilities),
      advertisedCapabilities: normalizeCapabilities(advertised),
    });
  }

  private requireCapability(action: string, capability: string): void {
    if (!this.capProfile.enforceAdvertised) return;
    const snapshot = this.capabilitySnapshot();
    if (!snapshot.known || hasCapability(snapshot.capabilities, capability)) return;
    if (capability === CapabilityDiagnostics && this.capProfile.legacyPushDiagnostics) return;
    const explanation = `the ${this.capabilityBackend()} backend did not advertise or establish the ${capability} capability`;
    throw this.unsupportedCapabilityError(
      action,
      explanation,
      snapshot.capabilities,
      snapshot.advertised_capabilities,
    );
  }

  private requirePathCapability(path: string, action: string, capability: string): void {
    const adapter = this.pathCapabilityAdapter;
    if (!adapter?.pathCapabilityForAction) return;
    const [decision, handled] = adapter.pathCapabilityForAction(path, action, capability) as [
      PathCapabilityDecision,
      boolean,
    ];
    if (!handled || decision.supported) return;
    let explanation = (decision.explanation ?? "").trim();
    if (explanation === "") {
      explanation = `the ${this.capabilityBackend()} backend does not support action "${action}" for this path`;
    }
    throw this.unsupportedCapabilityError(
      action,
      explanation,
      decision.capabilities ?? [],
      decision.advertisedCapabilities ?? [],
    );
  }

  private pathCapabilityBlocksAll(path: string): boolean {
    const adapter = this.pathCapabilityAdapter;
    if (!adapter?.pathCapabilityForAction) return false;
    const [decision, handled] = adapter.pathCapabilityForAction(path, "", "") as [
      PathCapabilityDecision,
      boolean,
    ];
    return handled && !decision.supported;
  }

  // ---- JSON-RPC plumbing ----

  private async initialize(ctx: Ctx): Promise<void> {
    const params: Record<string, unknown> = { ...(this.initParams ?? {}) };
    if (!("rootUri" in params) && !("rootPath" in params)) params.rootUri = fileURI(this.root);
    params.processId = process.pid;
    params.capabilities = { window: { workDoneProgress: true } };
    const result = (await this.requestRaw(ctx, "initialize", params)) as
      | { capabilities?: Record<string, unknown> }
      | null
      | undefined;
    this.capabilitiesKnown = true;
    this.advertisedCapabilities = normalizeInitializeCapabilities(result?.capabilities);
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error(`lsp server ${this.command.language} not initialized`);
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(msg: unknown): void {
    const stdin = this.child?.stdin;
    if (!this.running || !stdin) throw new Error(`lsp server ${this.command.language} not running`);
    const data = Buffer.from(JSON.stringify(msg), "utf8");
    stdin.write(
      Buffer.concat([Buffer.from(`Content-Length: ${data.length}\r\n\r\n`, "ascii"), data]),
    );
    this.trace("-->", data);
  }

  private trace(direction: string, payload: Buffer): void {
    this.traceWriter?.write(`${direction} ${payload.toString("utf8")}\n`);
  }

  /** request: JSON-RPC call with the initialized guard. Returns the raw `result` (null when absent). */
  async request(ctx: Ctx, method: string, params: unknown): Promise<unknown> {
    if (method !== "initialize" && method !== "shutdown") this.requireInitialized();
    try {
      return await this.requestRaw(ctx, method, params);
    } catch (e) {
      if (!this.running) this.files.reset();
      throw e;
    }
  }

  private requestRaw(ctx: Ctx, method: string, params: unknown): Promise<unknown> {
    const e0 = ctxErr(ctx);
    if (e0) return Promise.reject(e0);
    const id = ++this.nextId;
    const p = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    try {
      this.write({ jsonrpc: "2.0", id, method, params });
    } catch (e) {
      this.pending.delete(id);
      return Promise.reject(e);
    }
    return raceAbort(ctx, p).catch((e) => {
      this.pending.delete(id);
      throw e;
    });
  }

  private async shutdown(ctx: Ctx): Promise<void> {
    await this.requestRaw(ctx, "shutdown", null);
  }

  private failPending(err: unknown): void {
    const list = [...this.pending.values()];
    this.pending.clear();
    for (const p of list) p.reject(err);
  }

  private onData(child: ChildProcess, chunk: Buffer): void {
    if (this.child !== child) return;
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buf.subarray(0, headerEnd).toString("ascii");
      let length = 0;
      for (const line of header.split("\r\n")) {
        const m = /^content-length:\s*(\d+)/i.exec(line.trim());
        if (m) length = Number(m[1]);
      }
      if (length <= 0) {
        this.markProtocolFailure(new Error("missing content length"));
        return;
      }
      if (this.buf.length < headerEnd + 4 + length) return;
      const body = this.buf.subarray(headerEnd + 4, headerEnd + 4 + length);
      this.buf = this.buf.subarray(headerEnd + 4 + length);
      this.handleMessage(body);
      if (!this.running) return;
    }
  }

  private handleMessage(body: Buffer): void {
    this.trace("<--", body);
    let msg: {
      id?: number | string | null;
      method?: string;
      params?: unknown;
      error?: unknown;
      result?: unknown;
    };
    try {
      msg = JSON.parse(body.toString("utf8"));
    } catch (e) {
      this.markProtocolFailure(e);
      return;
    }
    if (msg.method) {
      this.handleNotification(msg.method, msg.params);
      if (msg.id !== undefined && msg.id !== null && !this.pending.has(msg.id as number)) {
        try {
          this.write({ jsonrpc: "2.0", id: msg.id, result: serverRequestResult(msg.method) });
        } catch {
          // ignored like Go
        }
      }
      return;
    }
    if (msg.id === undefined || msg.id === null) return;
    const entry = this.pending.get(msg.id as number);
    if (!entry) return;
    this.pending.delete(msg.id as number);
    if (msg.error !== undefined && msg.error !== null) {
      entry.reject(new Error(`lsp ${this.command.language}: ${JSON.stringify(msg.error)}`));
      return;
    }
    entry.resolve(msg.result ?? null);
  }

  private markProtocolFailure(err: unknown): void {
    this.running = false;
    this.initialized = false;
    this.clearCapabilities();
    this.clearDiagnostics();
    this.child?.kill();
    this.failPending(err);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "textDocument/publishDiagnostics") {
      const p = params as { uri?: string; diagnostics?: Diagnostic[] } | undefined;
      if (!p?.uri) return;
      this.observeCapability(CapabilityDiagnostics);
      this.diagnosticsByURI.set(p.uri, p.diagnostics ?? []);
    } else if (method === "$/progress") {
      const v = (params as { value?: { kind?: string } } | undefined)?.value;
      if (v?.kind === "end") this.readyResolve();
    }
  }

  // ---- diagnostics cache ----

  private cachedDiagnostics(path: string): Diagnostic[] | undefined {
    for (const [uri, d] of this.diagnosticsByURI) {
      if (sameFileURI(uri, path)) return cloneDiagnostics(d);
    }
    return undefined;
  }

  private clearDiagnostics(): void {
    this.diagnosticsByURI = new Map();
    this.diagnosticResultIDs = new Map();
  }

  private cachedDiagnosticResultID(path: string): string {
    for (const [uri, id] of this.diagnosticResultIDs) if (sameFileURI(uri, path)) return id;
    return "";
  }

  private cacheDiagnosticResultID(path: string, resultID: string): void {
    const uri = fileURI(path);
    if (resultID === "") this.diagnosticResultIDs.delete(uri);
    else this.diagnosticResultIDs.set(uri, resultID);
  }

  private cachePulledDiagnostics(path: string, resultID: string, diagnostics: Diagnostic[]): void {
    const uri = fileURI(path);
    this.diagnosticsByURI.set(uri, cloneDiagnostics(diagnostics) ?? []);
    if (resultID !== "") this.diagnosticResultIDs.set(uri, resultID);
    else this.diagnosticResultIDs.delete(uri);
    this.observeCapability(CapabilityDiagnostics);
  }

  // ---- queries ----

  async definition(ctx: Ctx, path: string, line: number, col: number): Promise<Location> {
    this.requirePathCapability(path, "definition", CapabilityDefinition);
    await this.start(ctx);
    this.requireCapability("definition", CapabilityDefinition);
    const locs = await this.locations(ctx, "textDocument/definition", path, line, col);
    const first = locs[0];
    if (!first) throw new Error("definition not found");
    return first;
  }

  async references(ctx: Ctx, path: string, line: number, col: number): Promise<Location[]> {
    this.requirePathCapability(path, "references", CapabilityReferences);
    await this.start(ctx);
    this.requireCapability("references", CapabilityReferences);
    const params = positionParams(path, line, col);
    params.context = { includeDeclaration: false };
    return this.locationsWithParams(ctx, "textDocument/references", params);
  }

  async implementations(ctx: Ctx, path: string, line: number, col: number): Promise<Location[]> {
    this.requirePathCapability(path, "implementations", CapabilityImplementation);
    await this.start(ctx);
    this.requireCapability("implementations", CapabilityImplementation);
    return this.locations(ctx, "textDocument/implementation", path, line, col);
  }

  async diagnostics(ctx: Ctx, path: string): Promise<Diagnostic[]> {
    this.requirePathCapability(path, "diagnostics", CapabilityDiagnostics);
    await this.start(ctx);
    this.requireCapability("diagnostics", CapabilityDiagnostics);
    await this.files.open(path);
    try {
      if (hasCapability(this.capabilitySnapshot().advertised_capabilities, CapabilityDiagnostics)) {
        return await this.pullDiagnostics(ctx, path);
      }
      const cached = this.cachedDiagnostics(path);
      if (cached) return cached;
      return await this.pumpLegacyDiagnostics(ctx, path);
    } finally {
      await this.files.close(path);
    }
  }

  private async pullDiagnostics(ctx: Ctx, path: string): Promise<Diagnostic[]> {
    const params: Record<string, unknown> = { textDocument: { uri: fileURI(path) } };
    const prev = this.cachedDiagnosticResultID(path);
    if (prev !== "") params.previousResultId = prev;
    const raw = await this.request(ctx, "textDocument/diagnostic", params);
    if (raw === null || raw === undefined) return this.cachedDiagnostics(path) ?? [];
    const report = raw as { kind?: string; resultId?: string; items?: Diagnostic[] };
    switch (report.kind ?? "") {
      case "full":
      case "":
        this.cachePulledDiagnostics(path, report.resultId ?? "", report.items ?? []);
        return cloneDiagnostics(report.items) ?? [];
      case "unchanged":
        this.cacheDiagnosticResultID(path, report.resultId ?? "");
        return this.cachedDiagnostics(path) ?? [];
      default:
        throw new Error(
          `unsupported document diagnostic report kind ${JSON.stringify(report.kind)}`,
        );
    }
  }

  private async pumpLegacyDiagnostics(ctx: Ctx, path: string): Promise<Diagnostic[]> {
    if (
      !hasCapability(this.capabilitySnapshot().advertised_capabilities, CapabilityDocumentSymbols)
    ) {
      return this.cachedDiagnostics(path) ?? [];
    }
    await raceAbort(ctx, new Promise<void>((r) => setTimeout(r, legacyDiagnosticSettleDelay)));
    await this.request(ctx, "textDocument/documentSymbol", {
      textDocument: { uri: fileURI(path) },
    });
    return this.cachedDiagnostics(path) ?? [];
  }

  async documentSymbols(ctx: Ctx, path: string): Promise<DocumentSymbol[]> {
    this.requirePathCapability(path, "symbols", CapabilityDocumentSymbols);
    await this.start(ctx);
    this.requireCapability("symbols", CapabilityDocumentSymbols);
    await this.files.open(path);
    try {
      const raw = await this.request(ctx, "textDocument/documentSymbol", {
        textDocument: { uri: fileURI(path) },
      });
      if (raw === null || raw === undefined) return [];
      if (!Array.isArray(raw))
        throw new Error("json: cannot unmarshal object into Go value of type []lsp.DocumentSymbol");
      const first = raw[0] as { location?: Location } | undefined;
      if (first?.location?.uri) {
        // flat SymbolInformation (gopls)
        return (raw as { name: string; kind: number; location: Location }[]).map((item) => ({
          name: item.name,
          kind: item.kind,
          range: item.location.range,
          selectionRange: item.location.range,
        }));
      }
      return raw as DocumentSymbol[];
    } finally {
      await this.files.close(path);
    }
  }

  async workspaceSymbol(ctx: Ctx, query: string): Promise<WorkspaceSymbolResult[]> {
    await this.start(ctx);
    this.requireCapability("symbols", CapabilityWorkspaceSymbols);
    const raw = await this.request(ctx, "workspace/symbol", { query });
    if (raw === null || raw === undefined) return [];
    return raw as WorkspaceSymbolResult[];
  }

  async rename(
    ctx: Ctx,
    path: string,
    line: number,
    col: number,
    newName: string,
  ): Promise<WorkspaceEdit> {
    this.requirePathCapability(path, "rename", CapabilityRename);
    await this.start(ctx);
    this.requireCapability("rename", CapabilityRename);
    const params = positionParams(path, line, columnForLine(path, line, col));
    params.newName = newName;
    const raw = (await this.request(
      ctx,
      "textDocument/rename",
      params,
    )) as Partial<WorkspaceEdit> | null;
    return { changes: raw?.changes ?? null, documentChanges: raw?.documentChanges ?? null };
  }

  private async locations(
    ctx: Ctx,
    method: string,
    path: string,
    line: number,
    col: number,
  ): Promise<Location[]> {
    return this.locationsWithParams(
      ctx,
      method,
      positionParams(path, line, columnForLine(path, line, col)),
    );
  }

  private async locationsWithParams(
    ctx: Ctx,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Location[]> {
    const raw = await this.request(ctx, method, params);
    if (raw === null || raw === undefined) return [];
    if (Array.isArray(raw)) {
      const links = raw as {
        targetUri?: string;
        targetRange?: Range;
        targetSelectionRange?: Range;
      }[];
      const first = links[0];
      if (first?.targetUri) {
        return links.map((l) => {
          let rng = l.targetSelectionRange as Range;
          if (!rng || emptyRange(rng)) rng = l.targetRange as Range;
          return { uri: l.targetUri as string, range: rng };
        });
      }
      return raw as Location[];
    }
    return [raw as Location];
  }
}

function positionParams(path: string, line: number, col: number): Record<string, unknown> {
  return {
    textDocument: { uri: fileURI(path) },
    position: { line, character: col },
  };
}

/** traceLogWriter: appends each trace line to a file, creating its directory. */
export class TraceLogWriter implements Writer {
  constructor(readonly path: string) {}
  write(chunk: string | Uint8Array): void {
    if (this.path === "") return;
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, chunk, { mode: 0o644 });
  }
}

export { WrappedError };
