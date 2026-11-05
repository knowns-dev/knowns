// Port of internal/lsp/filesync.go: reference-counted didOpen/didClose with an idle TTL.
const defaultFileSyncTTL = 30_000;

interface FileEntry {
  refs: number;
  lastAccess: number;
  timer?: ReturnType<typeof setTimeout>;
}

export class FileSync {
  private files = new Map<string, FileEntry>();
  private ttl = defaultFileSyncTTL;

  constructor(
    private openFn: ((path: string) => Promise<void>) | undefined,
    private closeFn: ((path: string) => Promise<void>) | undefined,
  ) {}

  setTTL(ms: number): void {
    this.ttl = ms;
  }

  async open(path: string): Promise<void> {
    const now = performance.now();
    const entry = this.files.get(path);
    if (entry) {
      entry.lastAccess = now;
      entry.refs++;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
      }
      return;
    }
    // Reserve the slot before awaiting so concurrent opens share one didOpen (Go holds a mutex).
    const created: FileEntry = { refs: 1, lastAccess: now };
    this.files.set(path, created);
    if (this.openFn) {
      try {
        await this.openFn(path);
      } catch (e) {
        if (this.files.get(path) === created) this.files.delete(path);
        throw e;
      }
    }
  }

  async close(path: string): Promise<void> {
    const entry = this.files.get(path);
    if (!entry || entry.refs === 0) return;
    entry.refs--;
    entry.lastAccess = performance.now();
    if (entry.refs > 0) return;
    this.scheduleClose(path, entry);
  }

  async closeAll(): Promise<void> {
    const paths: string[] = [];
    for (const [path, entry] of this.files) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
      paths.push(path);
    }
    this.files = new Map();
    if (!this.closeFn) return;
    for (const path of paths) await this.closeFn(path);
  }

  /** Forgets documents without notifying a server that has already failed. */
  reset(): void {
    for (const entry of this.files.values()) if (entry.timer) clearTimeout(entry.timer);
    this.files = new Map();
  }

  refCount(path: string): number {
    return this.files.get(path)?.refs ?? 0;
  }

  private scheduleClose(path: string, entry: FileEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    const lastAccess = entry.lastAccess;
    const fire = () => {
      void this.closeIfIdle(path, lastAccess);
    };
    if (this.ttl <= 0) {
      queueMicrotask(fire);
      return;
    }
    entry.timer = setTimeout(fire, this.ttl);
    // An idle close timer must not keep the process alive.
    (entry.timer as { unref?: () => void }).unref?.();
  }

  private async closeIfIdle(path: string, lastAccess: number): Promise<void> {
    const entry = this.files.get(path);
    if (entry?.refs !== 0 || entry.lastAccess !== lastAccess) return;
    this.files.delete(path);
    if (this.closeFn) {
      try {
        await this.closeFn(path);
      } catch {
        // Go: _ = closeFn(path)
      }
    }
  }
}
