// internal/tunnel/cloudflared/daemon.go, internal/server/tunnel.go and routes/tunnel.go: a shared
// `cloudflared tunnel --url` process keyed by local port, with state in
// ~/.knowns/cloudflared-<port>.{pid,url,log}.
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { goLookPathError } from "../platform/goerror.ts";
import type { App } from "./app.ts";
import { jsonResponse, type Router, respondError } from "./http.ts";
import type { Broadcaster } from "./sse.ts";

export interface TunnelStatus {
  running: boolean;
  url?: string;
  pid?: number;
  startedByUs?: boolean;
}

export function installHint(): string {
  const docs =
    "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
  switch (process.platform) {
    case "darwin":
      return `Install cloudflared:\n  brew install cloudflared\n  # or: ${docs}`;
    case "linux":
      return `Install cloudflared:\n  # Debian/Ubuntu:\n  curl -L https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null\n  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main' | sudo tee /etc/apt/sources.list.d/cloudflared.list\n  sudo apt update && sudo apt install cloudflared\n  # Other distros: ${docs}`;
    case "win32":
      return `Install cloudflared:\n  winget install --id Cloudflare.cloudflared\n  # or: ${docs}`;
    default:
      return `Install cloudflared from ${docs}`;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return r.status === 0 && (r.stdout ?? "").includes(String(pid));
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lookPath(name: string): string | undefined {
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of (process.env.PATH ?? "").split(sep)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const TRY_RE = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

export class Daemon {
  readonly pidFile: string;
  readonly urlFile: string;
  readonly logFile: string;
  private startedByUsFlag = false;

  constructor(readonly localPort: number) {
    const dir = join(process.env.HOME || process.env.USERPROFILE || homedir(), ".knowns");
    this.pidFile = join(dir, `cloudflared-${localPort}.pid`);
    this.urlFile = join(dir, `cloudflared-${localPort}.url`);
    this.logFile = join(dir, `cloudflared-${localPort}.log`);
  }

  startedByUs(): boolean {
    return this.startedByUsFlag;
  }

  readPID(): number {
    const text = readFileSync(this.pidFile, "utf8").trim();
    if (!/^[+-]?\d+$/.test(text))
      throw new Error(`strconv.Atoi: parsing ${JSON.stringify(text)}: invalid syntax`);
    return Number(text);
  }

  publicURL(): string {
    return readFileSync(this.urlFile, "utf8").trim();
  }

  isHealthy(): boolean {
    let pid: number;
    try {
      pid = this.readPID();
    } catch {
      return false;
    }
    if (!isProcessAlive(pid)) return false;
    try {
      return this.publicURL() !== "";
    } catch {
      return false;
    }
  }

  private cleanupStale(): void {
    try {
      const pid = this.readPID();
      if (!isProcessAlive(pid)) {
        rmSync(this.pidFile, { force: true });
        rmSync(this.urlFile, { force: true });
      }
    } catch {
      // no pid file
    }
  }

  async ensureRunning(): Promise<void> {
    if (!lookPath("cloudflared")) {
      throw new Error(`cloudflared not found in PATH.\n${installHint()}`);
    }
    if (this.isHealthy()) return;
    this.cleanupStale();
    await this.start();
  }

  async stop(): Promise<void> {
    let pid: number;
    try {
      pid = this.readPID();
    } catch {
      return;
    }
    // Not in Go: a pid file holding 0, 1 or a negative number would signal a process group, init
    // or every process the user owns. Only a real child pid is ever written there.
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      rmSync(this.pidFile, { force: true });
      rmSync(this.urlFile, { force: true });
      return;
    }
    try {
      if (process.platform === "win32") process.kill(pid, "SIGKILL");
      else process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && isProcessAlive(pid)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
    rmSync(this.pidFile, { force: true });
    rmSync(this.urlFile, { force: true });
  }

  private async start(): Promise<void> {
    mkdirSync(dirname(this.pidFile), { recursive: true, mode: 0o755 });
    let fd: number;
    try {
      fd = openSync(this.logFile, "w", 0o644);
    } catch (e) {
      throw new Error(`open cloudflared log: ${(e as Error).message}`);
    }
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      // The child writes straight to the log file (no pipe to this process), so it outlives the
      // server without SIGPIPE; the public URL is read back from the log.
      proc = Bun.spawn(
        ["cloudflared", "tunnel", "--no-autoupdate", "--url", `http://localhost:${this.localPort}`],
        { stdin: "ignore", stdout: fd, stderr: fd, detached: true, windowsHide: true },
      );
    } catch (e) {
      closeSync(fd);
      throw new Error(`start cloudflared: ${(e as Error).message}`);
    }
    closeSync(fd);
    proc.unref();
    try {
      mkdirSync(dirname(this.pidFile), { recursive: true, mode: 0o755 });
      writeFileSync(this.pidFile, String(proc.pid), { mode: 0o644 });
    } catch {
      // logged in Go
    }
    this.startedByUsFlag = true;
    const deadline = Date.now() + 20_000;
    const seen = 0;
    while (Date.now() < deadline) {
      let text = "";
      try {
        text = readFileSync(this.logFile, "utf8");
      } catch {
        // not yet
      }
      const m = TRY_RE.exec(text.slice(seen === 0 ? 0 : 0));
      if (m) {
        writeFileSync(this.urlFile, m[0], { mode: 0o644 });
        return;
      }
      if (proc.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for cloudflared public URL (see ${this.logFile})`);
  }
}

/** ServerTunnelManager wraps the daemon lazily, like Go. */
export class ServerTunnelManager {
  private daemon: Daemon | undefined;
  constructor(private readonly port: number) {}

  async start(): Promise<string> {
    if (this.daemon?.isHealthy()) {
      try {
        const url = this.daemon.publicURL();
        console.log(`  ✓  Tunnel active: ${url}`);
        return url;
      } catch {
        // restart below
      }
    }
    this.daemon = new Daemon(this.port);
    await this.daemon.ensureRunning();
    let url: string;
    try {
      url = this.daemon.publicURL();
    } catch (e) {
      throw new Error(`tunnel started but failed to capture URL: ${(e as Error).message}`);
    }
    console.log(`  ✓  Tunnel active: ${url}`);
    return url;
  }

  async stop(): Promise<void> {
    if (!this.daemon) return;
    await this.daemon.stop();
    console.log("  ✗  Tunnel stopped");
  }

  status(): TunnelStatus {
    if (!this.daemon || !this.daemon.isHealthy()) return { running: false };
    const out: TunnelStatus = { running: true };
    let url = "";
    try {
      url = this.daemon.publicURL();
    } catch {
      url = "";
    }
    let pid = 0;
    try {
      pid = this.daemon.readPID();
    } catch {
      pid = 0;
    }
    if (url) out.url = url;
    if (pid) out.pid = pid;
    if (this.daemon.startedByUs()) out.startedByUs = true;
    return out;
  }
}

function broadcastStatus(sse: Broadcaster, status: TunnelStatus): void {
  sse.broadcast({ type: "tunnel:status", data: status });
}

function tunnelError(msg: string): Response {
  const lower = msg.toLowerCase();
  if (lower.includes("cloudflared not found") || lower.includes("executable file not found")) {
    return jsonResponse(400, {
      error: "cloudflared not installed",
      installHint: "brew install cloudflared",
    });
  }
  return jsonResponse(500, { details: msg, error: "tunnel failed to start" });
}

export function registerTunnel(
  r: Router,
  app: App,
  tunnel: ServerTunnelManager,
  protectionReady: () => boolean,
): void {
  r.post("/api/tunnel/start", async () => {
    if (!protectionReady()) {
      return respondError(403, "password protection is required before starting a public tunnel");
    }
    let url: string;
    try {
      url = await tunnel.start();
    } catch (e) {
      return tunnelError(e instanceof Error ? e.message : String(e));
    }
    broadcastStatus(app.sse, tunnel.status());
    return jsonResponse(200, { status: "running", url });
  });
  r.post("/api/tunnel/stop", async () => {
    try {
      await tunnel.stop();
    } catch (e) {
      return jsonResponse(500, {
        details: e instanceof Error ? e.message : String(e),
        error: "tunnel failed to stop",
      });
    }
    broadcastStatus(app.sse, tunnel.status());
    return jsonResponse(200, { status: "stopped" });
  });
  r.get("/api/tunnel/status", () => jsonResponse(200, tunnel.status()));
}

void goLookPathError;
