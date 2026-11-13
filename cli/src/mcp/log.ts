// Port of newMCPLogger (internal/mcp/server.go): lines go to stderr and to
// ~/.knowns/logs/mcp.log with size rotation, never to stdout.
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024;
const DEFAULT_MAX_BACKUPS = 3;

function atoi(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[+-]?\d+$/.test(raw)) return undefined;
  return Number(raw);
}

class RotatingFile {
  private fd: number;
  private size: number;
  constructor(
    private readonly path: string,
    private readonly maxSize: number,
    private readonly maxBackups: number,
  ) {
    this.fd = openSync(path, "a", 0o644);
    this.size = statSync(path).size;
  }

  write(text: string): void {
    const len = Buffer.byteLength(text);
    if (this.maxSize > 0 && this.size + len > this.maxSize) this.rotate();
    const n = writeSync(this.fd, text);
    this.size += n;
  }

  private rotate(): void {
    closeSync(this.fd);
    const p = this.path;
    if (this.maxBackups > 0) {
      rmSync(`${p}.${this.maxBackups}`, { force: true });
      for (let i = this.maxBackups - 1; i >= 1; i--) {
        try {
          renameSync(`${p}.${i}`, `${p}.${i + 1}`);
        } catch {
          // missing backup
        }
      }
      try {
        renameSync(p, `${p}.1`);
      } catch {
        // ignore
      }
    } else {
      rmSync(p, { force: true });
    }
    this.fd = openSync(p, "w", 0o644);
    this.size = 0;
  }
}

function cleanupOldLogs(dir: string, maxAgeMs: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of names) {
    if (name === "mcp.log" || !name.startsWith("mcp-") || !name.endsWith(".log")) continue;
    try {
      const st = statSync(join(dir, name));
      if (st.isFile() && st.mtimeMs < cutoff) rmSync(join(dir, name), { force: true });
    } catch {
      // ignore
    }
  }
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** log.LstdFlags: 2006/01/02 15:04:05 in local time. */
export function stdTimestamp(d: Date = new Date()): string {
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export class McpLogger {
  private file: RotatingFile | undefined;
  private opened = false;
  constructor(
    private readonly pid: number = process.pid,
    private readonly stderr: (text: string) => void = (t) => {
      try {
        writeSync(2, t);
      } catch {
        // stderr closed
      }
    },
  ) {}

  private open(): void {
    if (this.opened) return;
    this.opened = true;
    let home = "";
    try {
      home = process.env.HOME || process.env.USERPROFILE || homedir();
    } catch {
      return;
    }
    if (!home) return;
    try {
      const dir = join(home, ".knowns", "logs");
      mkdirSync(dir, { recursive: true, mode: 0o755 });
      cleanupOldLogs(dir, 7 * 24 * 3600 * 1000);
      const size = atoi(process.env.KNOWNS_MCP_LOG_MAX_SIZE_MB);
      const backups = atoi(process.env.KNOWNS_MCP_LOG_MAX_BACKUPS);
      this.file = new RotatingFile(
        join(dir, "mcp.log"),
        size !== undefined && size > 0 ? size * 1024 * 1024 : DEFAULT_MAX_SIZE,
        backups !== undefined && backups >= 0 ? backups : DEFAULT_MAX_BACKUPS,
      );
    } catch {
      this.file = undefined;
    }
  }

  printf(message: string): void {
    const line = `[knowns-mcp pid=${this.pid}] ${stdTimestamp()} ${message}\n`;
    this.stderr(line);
    this.open();
    try {
      this.file?.write(line);
    } catch {
      // logging never fails a call
    }
  }
}
