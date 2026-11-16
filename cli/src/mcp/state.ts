// The per-server mutable state of internal/mcp/server.go: the active project (store), its root,
// the lazily built LSP manager and the help registry. Project detection runs in the background so
// `initialize` never waits for the storage libraries to load.
import type { Storage } from "../storage/adapters.ts";
import type { Store } from "../storage/core/store.ts";
import type { ClientInfo } from "./agent-client.ts";
import { buildHelpRegistry, type HelpEntry } from "./help-data.ts";
import type { McpLogger } from "./log.ts";

export interface Project {
  store: Store;
  storage: Storage;
}

type LspManager = import("../lsp/manager.ts").Manager;

export class McpState {
  project: Project | undefined;
  root = "";
  /** The MCP client that initialized this session (KN-4FQN0P); set by the initialize handshake. */
  clientInfo: ClientInfo | undefined;
  private lspManagerCache: LspManager | undefined;
  private lspManagerBuilt = false;
  readonly help: Map<string, HelpEntry> = buildHelpRegistry();
  private daemonWarned = false;

  constructor(readonly log: McpLogger) {}

  /** getStore */
  getProject(): Project | undefined {
    return this.project;
  }

  getRoot(): string {
    return this.root;
  }

  /** setStore: switching projects drops the LSP manager (rebuilt on next use). */
  async setProject(store: Store | undefined, root: string): Promise<void> {
    this.releaseCaches(); // the previous project's parsed files are not needed any more
    if (store) {
      const { createStorage } = await import("../storage/adapters.ts");
      this.project = { store, storage: createStorage(store) };
    } else {
      this.project = undefined;
    }
    this.root = root;
    this.lspManagerCache = undefined;
    this.lspManagerBuilt = false;
  }

  /** Drops the parsed task and doc files this project put in the shared search caches. */
  releaseCaches(): void {
    const root = this.project?.store.root;
    if (!root) return;
    void import("../storage/stores/task-store.ts").then((m) => m.releaseTaskCache(root));
    void import("../storage/stores/doc-store.ts").then((m) => m.releaseDocCache(root));
  }

  /** getLSPManager: built on first use from the project config and the machine defaults. */
  async getLspManager(): Promise<LspManager | undefined> {
    const project = this.project;
    if (!project) return undefined;
    if (this.lspManagerBuilt) return this.lspManagerCache;
    this.lspManagerBuilt = true;
    let cfg: ReturnType<Storage["config"]["load"]>;
    try {
      cfg = project.storage.config.load();
    } catch {
      return undefined;
    }
    const { Config } = await import("../lsp/config.ts");
    const { Manager } = await import("../lsp/manager.ts");
    const { all: allAdapters } = await import("../lsp/adapters/index.ts");
    const { EmbeddingSettingsStore } = await import(
      "../storage/stores/embedding-settings-store.ts"
    );
    let defaults: { settings?: unknown } | undefined;
    try {
      defaults = new EmbeddingSettingsStore().load().projectDefaults;
    } catch {
      defaults = undefined;
    }
    const manager = new Manager(this.root, Config.fromProject(cfg, defaults));
    for (const adapter of allAdapters()) {
      try {
        manager.registerAdapter(adapter);
      } catch (e) {
        this.log.printf(
          `warn: could not register LSP adapter ${adapter.id()}: ${(e as Error).message}`,
        );
      }
    }
    for (const err of manager.registerPluginAdapters({})) {
      this.log.printf(`warn: could not load LSP plugin adapter: ${err.message}`);
    }
    this.lspManagerCache = manager;
    liveStates.add(this);
    return manager;
  }

  /** Ends the session: stops the language servers this session started (a daemon-hosted session
   * outlives no process of its own, so nothing else would). */
  /** Stops this session's language servers and lets the next call build fresh ones. */
  async restartLsp(): Promise<void> {
    const manager = this.lspManagerCache;
    this.lspManagerCache = undefined;
    this.lspManagerBuilt = false;
    if (!manager) return;
    try {
      await manager.stopAll(undefined);
    } catch {
      // the servers may already be gone
    }
  }

  async dispose(): Promise<void> {
    liveStates.delete(this);
    const manager = this.lspManagerCache;
    this.lspManagerCache = undefined;
    this.lspManagerBuilt = true;
    if (!manager) return;
    try {
      await manager.stopAll(undefined);
    } catch {
      // the servers may already be gone
    }
  }

  /** The once-only "LSP daemon disabled" warning. */
  warnDaemonDisabledOnce(text: string): void {
    if (this.daemonWarned) return;
    this.daemonWarned = true;
    this.log.printf(`warn: ${text}`);
  }
}

const liveStates = new Set<McpState>();

/** Restarts the language servers of every session in this process (hung heavy calls, pool leak). */
export async function restartAllLanguageServers(): Promise<void> {
  await Promise.allSettled([...liveStates].map((st) => st.restartLsp()));
}
