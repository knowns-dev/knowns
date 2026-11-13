// Builds and drives cli/test/helpers/go-helper.go, which calls the real Go storage code.
// Tests that need it call `requireGoHelper()` and are skipped when no Go toolchain is available.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..", "..");
const SOURCE = join(import.meta.dir, "go-helper.go");
const OUT_DIR = join(tmpdir(), "knowns-ts-test-go-helper");

let built: string | undefined | null = null;

/** Path of the built helper, or undefined when Go is unavailable or the build fails. */
export function goHelperPath(): string | undefined {
  if (built !== null) return built;
  const exe = join(OUT_DIR, process.platform === "win32" ? "go-helper.exe" : "go-helper");
  mkdirSync(OUT_DIR, { recursive: true });
  if (existsSync(exe) && statSync(exe).mtimeMs > statSync(SOURCE).mtimeMs) {
    built = exe;
    return built;
  }
  const res = Bun.spawnSync(["go", "build", "-o", exe, SOURCE], {
    cwd: REPO,
    stderr: "pipe",
    stdout: "pipe",
  });
  built = res.exitCode === 0 ? exe : undefined;
  if (!built) console.warn(`go helper unavailable: ${res.stderr.toString().slice(0, 300)}`);
  return built;
}

export const hasGoHelper = (): boolean => goHelperPath() !== undefined;

/** An isolated HOME so the helper never reads the developer's registry. */
export function isolatedEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: "1",
    NO_UPDATE_CHECK: "1",
    // Without this the Go CLI forks a detached `__runtime run` whose cwd pins the project dir (EBUSY on Windows).
    KNOWNS_RUNTIME_INLINE: "1",
    KNOWNS_SEMANTIC_RUNTIME_DISABLED: "1",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

export function tempDir(prefix = "knowns-ts-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Run the helper to completion and return its stdout lines. */
export function runHelper(args: string[], home: string): string[] {
  const exe = goHelperPath();
  if (!exe) throw new Error("go helper unavailable");
  const res = Bun.spawnSync([exe, ...args], { env: isolatedEnv(home) });
  return res.stdout.toString().split("\n").filter(Boolean);
}

export interface RunningHelper {
  /** Resolves when a stdout line equal to `line` has been printed. */
  waitFor(line: string, timeoutMs?: number): Promise<number>;
  lines: string[];
  exited: Promise<number>;
  kill(): void;
}

/** Start the helper and stream its stdout. */
export function startHelper(args: string[], home: string): RunningHelper {
  const exe = goHelperPath();
  if (!exe) throw new Error("go helper unavailable");
  const child = spawn(exe, args, { env: isolatedEnv(home), stdio: ["ignore", "pipe", "inherit"] });
  const lines: string[] = [];
  const waiters: Array<{ line: string; resolve: (t: number) => void }> = [];
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      lines.push(line);
      for (const w of [...waiters]) {
        if (w.line === line) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(Date.now());
        }
      }
      idx = buffer.indexOf("\n");
    }
  });
  const exited = new Promise<number>((res) => child.on("exit", (code) => res(code ?? -1)));
  return {
    lines,
    exited,
    kill: () => child.kill(),
    waitFor(line, timeoutMs = 20_000) {
      return new Promise<number>((resolveWait, reject) => {
        const existing = lines.indexOf(line);
        if (existing >= 0) return resolveWait(Date.now());
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for "${line}"; got ${JSON.stringify(lines)}`)),
          timeoutMs,
        );
        waiters.push({
          line,
          resolve: (t) => {
            clearTimeout(timer);
            resolveWait(t);
          },
        });
      });
    },
  };
}
