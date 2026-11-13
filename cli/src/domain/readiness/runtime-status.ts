// Read side of internal/runtimequeue (LoadStatus and the helpers it uses), enough for the
// readiness payload: whether the shared runtime daemon is alive, how many clients hold a lease
// and how many jobs are queued or running. The queue itself (writes, daemon) belongs to the
// runtime queue task; this only reads the files Go's daemon writes under ~/.knowns/runtime.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, join } from "node:path";

export interface RuntimeStatus {
  enabled: boolean;
  running: boolean;
  connectedClients: number;
  queuedJobs: number;
  runningJobs: number;
  /** "healthy", "degraded" or "stopped". */
  state: string;
}

/** GlobalRoot of the runtime queue: $HOME/.knowns (os.UserHomeDir fallback, then the temp dir). */
function globalRoot(env: Record<string, string | undefined>): string {
  const home = env.HOME;
  if (home) return join(home, ".knowns");
  try {
    const h = homedir();
    if (h) return join(h, ".knowns");
  } catch {
    // fall through
  }
  return join(tmpdir(), ".knowns");
}

/** RuntimeRoot: KNOWNS_RUNTIME_ROOT or <global root>/runtime. */
export function runtimeRoot(env: Record<string, string | undefined> = process.env): string {
  const override = (env.KNOWNS_RUNTIME_ROOT ?? "").trim();
  return override !== "" ? override : join(globalRoot(env), "runtime");
}

/** isProcessAlive on unix: kill(pid, 0). EPERM still means the process exists? No: Go treats any error as dead. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** strings.TrimSpace for the ASCII and Unicode spaces Go trims. */
function goTrim(s: string): string {
  return s.replace(/^[\s\u0085]+|[\s\u0085]+$/g, "");
}

function readJSON(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** sanitizeProjectKey: <parent dir name>-<hex of a 31-multiplier rune hash>. */
export function sanitizeProjectKey(storeRoot: string): string {
  const clean = storeRoot.replace(/[\\/]+$/, "") || storeRoot;
  const parts = clean.split(/[\\/]/);
  parts.pop();
  let base = parts.pop() ?? "";
  if (base === "" || base === ".") base = "default";
  let h = 0;
  for (const ch of clean) h = (Math.imul(h, 31) + (ch.codePointAt(0) as number)) >>> 0;
  return `${base}-${h.toString(16).padStart(8, "0")}`;
}

interface JobLike {
  startedAt?: unknown;
}

/** LoadStatus + cliRuntimeReadiness: the runtime section of `knowns status`. */
export function loadRuntimeReadiness(
  env: Record<string, string | undefined> = process.env,
): RuntimeStatus {
  const root = runtimeRoot(env);
  try {
    let running = false;
    try {
      // strconv.Atoi(strings.TrimSpace(...)): the whole text must be an integer ("123abc" is an error).
      const text = goTrim(readFileSync(join(root, "knowns-runtime.pid"), "utf8"));
      if (/^[+-]?\d+$/.test(text)) running = isProcessAlive(Number(text));
    } catch {
      // no pid file: not running
    }

    // ActiveLeases (creates the lease dir, drops expired or orphaned leases).
    const leaseDir = join(root, "leases");
    mkdirSync(leaseDir, { recursive: true, mode: 0o755 });
    const now = Date.now();
    let clients = 0;
    for (const name of readdirSync(leaseDir)) {
      if (extname(name) !== ".json") continue;
      const lease = readJSON(join(leaseDir, name)) as
        | { expiresAt?: string; pid?: number }
        | undefined;
      if (!lease) continue;
      const expires = lease.expiresAt ? Date.parse(lease.expiresAt) : Number.NaN;
      if (!(expires > now)) {
        rmSync(join(leaseDir, name), { force: true });
        continue;
      }
      if ((lease.pid ?? 0) > 0 && !isProcessAlive(lease.pid as number)) {
        rmSync(join(leaseDir, name), { force: true });
        continue;
      }
      clients++;
    }

    let queued = 0;
    let runningJobs = 0;
    const registry = readJSON(join(root, "projects.json"));
    if (Array.isArray(registry)) {
      const seen = new Set<string>();
      for (const project of registry) {
        if (typeof project !== "string" || project === "" || seen.has(project)) continue;
        seen.add(project);
        const queuePath = join(root, "queues", `${sanitizeProjectKey(project)}.json`);
        if (!existsSync(queuePath)) continue;
        const state = readJSON(queuePath) as { jobs?: JobLike[] | null } | undefined;
        if (!state) continue;
        for (const job of state.jobs ?? []) {
          if (job.startedAt !== undefined && job.startedAt !== null) runningJobs++;
          else queued++;
        }
      }
    }
    return {
      enabled: true,
      running,
      connectedClients: clients,
      queuedJobs: queued,
      runningJobs,
      state: running ? "healthy" : "stopped",
    };
  } catch {
    return {
      enabled: true,
      running: false,
      connectedClients: 0,
      queuedJobs: 0,
      runningJobs: 0,
      state: "stopped",
    };
  }
}
