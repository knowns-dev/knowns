// Tells open tabs when a service (LSP, Qdrant, tunnel, ...) changes status. It runs only while
// somebody looks (a request that shows runtime or service status within `watchWindowMs`), because
// the inventory it takes is not free.
export interface ServiceStatusLike {
  name: string;
  type: string;
  status: string;
  pid?: number;
  port?: number;
  uptime?: number;
  enabledInConfig: boolean;
  details: Record<string, string>;
}

export const serviceKey = (s: ServiceStatusLike): string =>
  s.details.language ? `${s.type}:${s.details.language}` : `${s.type}:${s.name}`;

export function serviceJson(s: ServiceStatusLike): Record<string, unknown> {
  const keys = Object.keys(s.details).sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
  const details: Record<string, string> = {};
  for (const k of keys) details[k] = s.details[k] as string;
  return {
    name: s.name,
    type: s.type,
    status: s.status,
    ...(s.pid ? { pid: s.pid } : {}),
    ...(s.port ? { port: s.port } : {}),
    ...(s.uptime ? { uptime: s.uptime } : {}),
    enabledInConfig: s.enabledInConfig,
    ...(keys.length > 0 ? { details } : {}),
  };
}

export interface ServiceMonitorOptions {
  snapshot: () => Promise<ServiceStatusLike[] | undefined>;
  emit: (changes: Record<string, unknown>[]) => void;
  watchWindowMs: number;
  statusIntervalMs: number;
  idleIntervalMs: number;
  now?: () => number;
}

export class ServiceMonitor {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watchedAt = 0;
  private prev: ServiceStatusLike[] = [];
  /** Set while nobody is watching: the next snapshot is a fresh baseline, not a diff. */
  private gap = false;
  private stopped = false;
  private started = false;
  private readonly now: () => number;

  constructor(private readonly o: ServiceMonitorOptions) {
    this.now = o.now ?? Date.now;
  }

  private watching(): boolean {
    return this.now() - this.watchedAt < this.o.watchWindowMs;
  }

  /** A request that shows service status came in. When watching starts (or resumes after a gap)
   * the monitor looks at once instead of after the idle interval. */
  watch(): void {
    const resumed = !this.watching();
    this.watchedAt = this.now();
    if (resumed && this.started && !this.stopped) this.schedule(0);
  }

  start(): void {
    void (async () => {
      const first = await this.o.snapshot();
      if (first) this.prev = first;
      if (this.stopped) return;
      this.started = true;
      this.schedule(this.o.statusIntervalMs);
    })();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref();
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    const watched = this.watching();
    // Nobody has looked lately: the inventory is not worth running; check again later.
    if (!watched) this.gap = true;
    const next = watched ? await this.o.snapshot() : undefined;
    if (next && !this.stopped) {
      if (this.gap) {
        // After a gap the old snapshot is stale: diffing against it would report changes that
        // happened long ago as if they were new. Start over from what is there now.
        this.prev = next;
        this.gap = false;
      } else {
        const prevBy = new Map(this.prev.map((s) => [serviceKey(s), s]));
        const at = new Date(this.now()).toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
        const changes: Record<string, unknown>[] = [];
        for (const s of next) {
          const prev = prevBy.get(serviceKey(s));
          if (
            !prev ||
            (prev.status === s.status &&
              prev.pid === s.pid &&
              prev.port === s.port &&
              prev.enabledInConfig === s.enabledInConfig)
          ) {
            continue;
          }
          changes.push({
            name: s.name,
            type: s.type,
            previousStatus: prev.status,
            status: s.status,
            timestamp: at,
            service: serviceJson(s),
          });
        }
        this.prev = next;
        if (changes.length > 0) this.o.emit(changes);
      }
    }
    if (!this.stopped) {
      this.schedule(this.watching() ? this.o.statusIntervalMs : this.o.idleIntervalMs);
    }
  }
}
