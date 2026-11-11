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
    return manager;
  }

  /** The once-only "LSP daemon disabled" warning. */
  warnDaemonDisabledOnce(text: string): void {
    if (this.daemonWarned) return;
    this.daemonWarned = true;
    this.log.printf(`warn: ${text}`);
  }
}
