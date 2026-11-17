// Is this pid really a Knowns runtime daemon? A pid file outlives its process: after a crash or a
// reboot the number can belong to anything the user runs. Nothing may be signalled on the strength
// of a pid file alone, so a caller proves identity first and treats "cannot tell" as "not ours".
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The file name of a path in either separator style (a Windows path is read on any host). */
const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? "";

export interface ProcessInfo {
  /** The full command line (executable first). */
  commandLine: string;
  /** When the process started, ms since epoch. */
  startedAt: number;
}

/** The process's command line and start time, or undefined when it cannot be read. */
export function readProcessInfo(pid: number): ProcessInfo | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    return process.platform === "win32" ? readWindows(pid) : readUnix(pid);
  } catch {
    return undefined;
  }
}

/** `ps` by its fixed location, for the same reason as windowsPowerShell(). */
function unixPs(): string {
  for (const p of ["/bin/ps", "/usr/bin/ps"]) if (existsSync(p)) return p;
  return "ps";
}

function readUnix(pid: number): ProcessInfo | undefined {
  // LC_ALL=C pins lstart to "Mon Nov 16 10:00:00 2026" on every Unix.
  const env = { ...process.env, LC_ALL: "C", LANG: "C" };
  const run = (field: string): string | undefined => {
    const r = spawnSync(unixPs(), ["-ww", "-o", `${field}=`, "-p", String(pid)], {
      encoding: "utf8",
      env,
      timeout: 3000,
    });
    if (r.status !== 0) return undefined;
    const out = (r.stdout ?? "").trim();
    return out === "" ? undefined : out;
  };
  const commandLine = run("command");
  const lstart = run("lstart");
  if (commandLine === undefined || lstart === undefined) return undefined;
  const startedAt = Date.parse(lstart);
  if (Number.isNaN(startedAt)) return undefined;
  return { commandLine, startedAt };
}

/**
 * A Windows system tool by its fixed path under %SystemRoot%\\System32. A bare name is looked up on
 * $PATH, and a PATH without System32 (a sandbox, a launcher, a test that swapped it) made a read
 * return "unknown" in a few milliseconds: no stale daemon was ever recognised, so none was ever
 * stopped. Falls back to the bare name when the file is not there.
 */
export function windowsSystemTool(name: string, ...subdirs: string[]): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  const fixed = join(root, "System32", ...subdirs, name);
  return existsSync(fixed) ? fixed : name;
}

const windowsPowerShell = (): string =>
  windowsSystemTool("powershell.exe", "WindowsPowerShell", "v1.0");

function readWindows(pid: number): ProcessInfo | undefined {
  const script =
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
    "if ($p) { [pscustomobject]@{ c = ($p.CommandLine + ''); e = ($p.ExecutablePath + ''); " +
    "s = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress }";
  const r = spawnSync(
    windowsPowerShell(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", timeout: 8000, windowsHide: true },
  );
  if (r.status !== 0) return undefined;
  const text = (r.stdout ?? "").trim();
  if (text === "") return undefined;
  const j = JSON.parse(text) as { c: string; e: string; s: number };
  const commandLine = j.c !== "" ? j.c : j.e;
  if (commandLine === "" || !Number.isFinite(j.s)) return undefined;
  return { commandLine, startedAt: j.s };
}

/** Splits a command line into words, honouring double quotes. */
export function commandWords(commandLine: string): string[] {
  const words: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m = re.exec(commandLine); m; m = re.exec(commandLine)) words.push(m[1] ?? m[2] ?? "");
  return words;
}

/** Does this command line run the hidden `__runtime run` command of a Knowns build? */
export function isRuntimeDaemonCommand(commandLine: string): boolean {
  const words = commandWords(commandLine);
  const at = words.indexOf("__runtime");
  if (at < 0 || words[at + 1] !== "run") return false;
  // Compiled: `<knowns> __runtime run`. From source: `<bun|node> <script> __runtime run`.
  const exe = baseName(words[0] ?? "")
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (at === 1)
    return (
      exe.startsWith("knowns") ||
      exe ===
        baseName(process.execPath)
          .toLowerCase()
          .replace(/\.exe$/, "")
    );
  return at === 2 && (exe === "bun" || exe === "node" || exe.startsWith("knowns"));
}

/** What a pid must be to be signalled: an instance of this executable, started in time. */
export interface ProcessExpectation {
  /** The exact executable path (case-insensitive on Windows); the command line must start with it. */
  path?: string;
  /** Or any of these executable base names, without `.exe`. */
  names?: string[];
  /** These words must appear next to each other in the command line, in order. */
  args?: string[];
  /** The process must have started no later than this (ms since epoch), plus a minute of slack. */
  startedBefore?: number;
}

const stripExe = (name: string): string => name.toLowerCase().replace(/\.exe$/, "");
const normPath = (p: string): string => p.replace(/\\/g, "/").toLowerCase();

function hasWords(words: string[], want: string[]): boolean {
  if (want.length === 0) return true;
  for (let i = 0; i + want.length <= words.length; i++) {
    if (want.every((w, j) => words[i + j] === w)) return true;
  }
  return false;
}

/**
 * True only when `pid` is provably an instance of the expected executable (not this process, a
 * readable command line that matches, started no later than `startedBefore`). Anything that cannot
 * be established is "no": a caller treats the pid as stale and signals nothing.
 */
export function isProcessInstance(
  pid: number,
  exp: ProcessExpectation,
  seams: IdentitySeams = {},
): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  const info = (seams.info ?? readProcessInfo)(pid);
  if (!info) return false;
  const words = commandWords(info.commandLine);
  if (exp.path !== undefined) {
    const line = normPath(info.commandLine.replace(/^"/, ""));
    if (!line.startsWith(normPath(exp.path))) return false;
  } else if (exp.names !== undefined) {
    const exe = stripExe(baseName(words[0] ?? ""));
    if (!exp.names.map(stripExe).includes(exe)) return false;
  } else {
    return false; // an expectation must name the executable
  }
  if (!hasWords(words, exp.args ?? [])) return false;
  if (exp.startedBefore !== undefined && info.startedAt > exp.startedBefore + 60_000) return false;
  return true;
}

export interface IdentitySeams {
  info?: (pid: number) => ProcessInfo | undefined;
}

/**
 * True only when `pid` is provably a Knowns runtime daemon whose pid file (written at `writtenAt`,
 * ms since epoch) it could have written: not this process, running `__runtime run`, and started
 * no later than the file (a process that started after the file is a reused pid).
 */
export function isKnownsRuntimeDaemon(
  pid: number,
  writtenAt: number,
  seams: IdentitySeams = {},
): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  const info = (seams.info ?? readProcessInfo)(pid);
  if (!info) return false;
  if (!isRuntimeDaemonCommand(info.commandLine)) return false;
  // The daemon writes its pid file after it starts; allow a minute for clock and ps rounding.
  return info.startedAt <= writtenAt + 60_000;
}
