// Port of lifecycle.go: environment knobs, the daemon error type and small helpers.
import { errorIs } from "../lsp/errors.ts";
import type { LanguageRuntimeStatus } from "../lsp/types.ts";

export const EnvDaemonMode = "KNOWNS_LSP_DAEMON";
export const EnvDaemonIdleTimeout = "KNOWNS_LSP_DAEMON_IDLE_TIMEOUT";
export const EnvDaemonLeaseTTL = "KNOWNS_LSP_DAEMON_LEASE_TTL";

export const DaemonStateRunning = "running";
export const DaemonStateUnavailable = "unavailable";
export const DaemonStateDisabledByEnv = "disabled_by_env";

const defaultIdleTimeoutMs = 10 * 60_000;
const defaultLeaseTTLMs = 30 * 60_000;

export const ErrDisabledByEnv = new Error("LSP daemon disabled by KNOWNS_LSP_DAEMON");

export class DaemonError extends Error {
  override readonly cause: unknown;
  constructor(
    readonly operation: string,
    readonly logPath: string,
    readonly statePath: string,
    cause: unknown,
  ) {
    const op = operation.trim() === "" ? "use LSP daemon" : operation.trim();
    let message = `LSP daemon unavailable during ${op}`;
    if (cause) message += `: ${cause instanceof Error ? cause.message : String(cause)}`;
    if (logPath !== "") message += `; check daemon log ${logPath}`;
    if (statePath !== "") message += `; status state ${statePath}`;
    message += "; run `knowns lsp list --json` for current daemon/LSP status";
    super(message);
    this.name = "DaemonError";
    this.cause = cause;
  }
}

export function disabledByEnv(): boolean {
  const v = (process.env[EnvDaemonMode] ?? "").trim().toLowerCase();
  return ["0", "false", "off", "disabled", "disable", "no"].includes(v);
}

export function disabledWarning(): string {
  return "KNOWNS_LSP_DAEMON=0 disables shared LSP daemon routing; code requests may fan out duplicate per-process language servers";
}

const unitMs: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/** time.ParseDuration, in milliseconds; undefined when Go would reject the text. */
export function parseGoDuration(text: string): number | undefined {
  let s = text;
  let sign = 1;
  if (s === "") return undefined;
  if (s[0] === "-" || s[0] === "+") {
    if (s[0] === "-") sign = -1;
    s = s.slice(1);
  }
  if (s === "0") return 0;
  if (s === "") return undefined;
  let total = 0;
  const re = /^(\d*\.?\d*)(ns|us|µs|μs|ms|s|m|h)/;
  while (s !== "") {
    const m = re.exec(s);
    if (!m || m[1] === "" || m[1] === ".") return undefined;
    total += Number(m[1]) * (unitMs[m[2] as string] as number);
    s = s.slice(m[0].length);
  }
  return sign * total;
}

function durationFromEnv(name: string, fallbackMs: number): number {
  const value = (process.env[name] ?? "").trim();
  if (value === "") return fallbackMs;
  const d = parseGoDuration(value);
  if (d === undefined) return fallbackMs;
  return Math.max(d, 0);
}

/** Milliseconds. */
export function idleTimeoutFromEnv(): number {
  return durationFromEnv(EnvDaemonIdleTimeout, defaultIdleTimeoutMs);
}
/** Milliseconds. */
export function leaseTTLFromEnv(): number {
  return durationFromEnv(EnvDaemonLeaseTTL, defaultLeaseTTLMs);
}

export function annotateLocalStatuses(
  statuses: LanguageRuntimeStatus[],
  daemonState: string,
): LanguageRuntimeStatus[] {
  for (const s of statuses) {
    s.owner = "local";
    s.daemon_state = daemonState;
  }
  return statuses;
}

export function formatDeadline(ms: number | undefined): string {
  if (!ms) return "";
  return new Date(ms).toISOString();
}

export function validateLeaseOwner(owner: string): string {
  const o = owner.trim();
  if (o === "") throw new Error("lease owner is required");
  if (o.length > 80) throw new Error(`lease owner ${JSON.stringify(o)} is too long`);
  return o;
}

export function isDisabledByEnvError(err: unknown): boolean {
  return errorIs(err, ErrDisabledByEnv);
}
