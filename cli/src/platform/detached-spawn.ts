// Start a long-lived background process that must not hold on to anything of its parent.
//
// Why this exists: on Windows a child created with bInheritHandles = TRUE inherits every handle
// marked inheritable, and Bun's listening sockets are. `knowns browser` used to start the LSP
// daemon through node:child_process, the daemon inherited the browser's LISTEN socket, and when the
// browser died the daemon kept the port bound (netstat showed the dead browser's PID as owner), so
// the next browser on that port hung. Here the Windows path calls CreateProcessW itself with
// PROC_THREAD_ATTRIBUTE_HANDLE_LIST, which restricts inheritance to exactly the handles listed: a
// NUL stdin and the log file. Nothing else crosses over. Elsewhere the child gets the same
// stdio contract through node:child_process, where fds are close-on-exec.

import { dlopen, FFIType, ptr } from "bun:ffi";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

export interface DetachedOptions {
  /** Stdout and stderr of the child are appended here. */
  logPath: string;
  /** POSIX file mode used when the log is created. */
  logMode?: number;
  /** Defaults to the parent's environment. */
  env?: Record<string, string | undefined>;
  cwd?: string;
}

/** Spawn cmd detached from this process; resolves to the child's pid. Throws when it cannot start. */
export function spawnDetached(cmd: string, args: string[], opts: DetachedOptions): number {
  if (process.platform === "win32") {
    try {
      return spawnWindows(cmd, args, opts);
    } catch (e) {
      // FFI or CreateProcessW is unavailable here: keep working the old way, and say so once.
      if (!warnedFallback) {
        warnedFallback = true;
        process.stderr.write(
          `[knowns] detached spawn via CreateProcessW failed (${(e as Error).message}); falling back to child_process\n`,
        );
      }
    }
  }
  return spawnNode(cmd, args, opts);
}

let warnedFallback = false;

function spawnNode(cmd: string, args: string[], opts: DetachedOptions): number {
  const fd = openSync(opts.logPath, "a", opts.logMode ?? 0o644);
  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
      env: opts.env as NodeJS.ProcessEnv | undefined,
      cwd: opts.cwd,
    });
    child.on("error", () => {});
    child.unref();
    if (child.pid === undefined) throw new Error(`spawn ${cmd}: no pid`);
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

// --- windows ---------------------------------------------------------------------------------

const GENERIC_READ = 0x8000_0000;
const FILE_APPEND_DATA = 0x4;
const SHARE_ALL = 0x7;
const OPEN_EXISTING = 3;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const STARTF_USESHOWWINDOW = 0x1;
const STARTF_USESTDHANDLES = 0x100;
const EXTENDED_STARTUPINFO_PRESENT = 0x80000;
const CREATE_UNICODE_ENVIRONMENT = 0x400;
const CREATE_NEW_PROCESS_GROUP = 0x200;
const CREATE_NO_WINDOW = 0x0800_0000;
const CREATE_BREAKAWAY_FROM_JOB = 0x0100_0000;
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x20002n;
const ERROR_ACCESS_DENIED = 5;
const INVALID_HANDLE = 0xffff_ffff_ffff_ffffn;
const STARTUPINFOEX_SIZE = 112;

type Kernel32 = ReturnType<typeof loadKernel32>;
let kernel32: Kernel32 | undefined;

function loadKernel32() {
  return dlopen("kernel32.dll", {
    CreateFileW: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.u64,
      ],
      returns: FFIType.u64,
    },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
    InitializeProcThreadAttributeList: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    UpdateProcThreadAttribute: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u64,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
    DeleteProcThreadAttributeList: { args: [FFIType.ptr], returns: FFIType.void },
    CreateProcessW: {
      args: [
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.i32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
  });
}

function wide(text: string): Buffer {
  return Buffer.from(`${text}\0`, "utf16le");
}

/** CommandLineToArgvW-compatible quoting of one argument. */
export function quoteWindowsArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += `${"\\".repeat(backslashes * 2 + 1)}"`;
    } else {
      out += `${"\\".repeat(backslashes)}${ch}`;
    }
    backslashes = 0;
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`;
}

/** The "A=B\0C=D\0\0" block CreateProcessW takes, sorted the way Windows expects. */
export function windowsEnvBlock(env: Record<string, string | undefined>): Buffer {
  const entries = Object.entries(env)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .sort((a, b) => a[0].toUpperCase().localeCompare(b[0].toUpperCase()));
  return Buffer.from(`${entries.map(([k, v]) => `${k}=${v}`).join("\0")}\0\0`, "utf16le");
}

function spawnWindows(cmd: string, args: string[], opts: DetachedOptions): number {
  kernel32 ??= loadKernel32();
  const k = kernel32.symbols;
  const fail = (what: string): never => {
    throw new Error(`${what} failed (win32 error ${k.GetLastError()}) for ${cmd}`);
  };

  // Inheritable handles, created here so they can be named in the handle list below.
  const sa = Buffer.alloc(24);
  sa.writeUInt32LE(24, 0);
  sa.writeUInt32LE(1, 16); // bInheritHandle
  const nul = k.CreateFileW(wide("NUL"), GENERIC_READ, SHARE_ALL, sa, OPEN_EXISTING, 0, 0n);
  if (nul === INVALID_HANDLE) fail("open NUL");
  const log = k.CreateFileW(
    wide(opts.logPath),
    FILE_APPEND_DATA,
    SHARE_ALL,
    sa,
    OPEN_ALWAYS,
    FILE_ATTRIBUTE_NORMAL,
    0n,
  );
  if (log === INVALID_HANDLE) {
    k.CloseHandle(nul);
    fail(`open log ${opts.logPath}`);
  }

  const handles = Buffer.alloc(16);
  handles.writeBigUInt64LE(nul, 0);
  handles.writeBigUInt64LE(log, 8);

  const sizeBuf = Buffer.alloc(8);
  k.InitializeProcThreadAttributeList(null, 1, 0, sizeBuf); // fails by design: reports the size
  const attrList = Buffer.alloc(Number(sizeBuf.readBigUInt64LE(0)));
  let attrReady = false;
  try {
    if (!k.InitializeProcThreadAttributeList(attrList, 1, 0, sizeBuf)) {
      fail("InitializeProcThreadAttributeList");
    }
    attrReady = true;
    if (
      !k.UpdateProcThreadAttribute(
        attrList,
        0,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        handles,
        16n,
        null,
        null,
      )
    ) {
      fail("UpdateProcThreadAttribute");
    }

    const si = Buffer.alloc(STARTUPINFOEX_SIZE);
    si.writeUInt32LE(STARTUPINFOEX_SIZE, 0);
    si.writeUInt32LE(STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW, 60);
    si.writeUInt16LE(0, 64); // SW_HIDE
    si.writeBigUInt64LE(nul, 80);
    si.writeBigUInt64LE(log, 88);
    si.writeBigUInt64LE(log, 96);
    si.writeBigUInt64LE(BigInt(ptr(attrList)), 104);

    const commandLine = wide([cmd, ...args].map(quoteWindowsArg).join(" "));
    const env = windowsEnvBlock(opts.env ?? (process.env as Record<string, string | undefined>));
    const cwd = opts.cwd ? wide(opts.cwd) : null;
    const base = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;
    const pi = Buffer.alloc(24);
    const create = (flags: number) =>
      k.CreateProcessW(null, commandLine, null, null, 1, flags, env, cwd, si, pi);

    // Breaking out of the parent's job keeps the child alive when the parent's job is torn down
    // (an ssh session, a terminal); jobs that forbid it answer ACCESS_DENIED, so retry without.
    let ok = create(base | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
    if (!ok && k.GetLastError() === ERROR_ACCESS_DENIED)
      ok = create(base | CREATE_NEW_PROCESS_GROUP);
    if (!ok) fail("CreateProcessW");

    k.CloseHandle(pi.readBigUInt64LE(0));
    k.CloseHandle(pi.readBigUInt64LE(8));
    return pi.readUInt32LE(16);
  } finally {
    if (attrReady) k.DeleteProcThreadAttributeList(attrList);
    k.CloseHandle(nul);
    k.CloseHandle(log);
  }
}
