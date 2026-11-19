// The command line and start time of a Windows process from the kernel, in well under a
// millisecond. Asking PowerShell for Win32_Process took 0.4 s on a quiet machine and more than 8 s
// on a cold CI runner (Defender and WMI starting up), which made an identity check the slowest and
// least predictable step of every stale-daemon decision. OpenProcess, GetProcessTimes and
// NtQueryInformationProcess(ProcessCommandLineInformation) need only PROCESS_QUERY_LIMITED_INFORMATION
// and read nothing from the other process's memory.
import type { ProcessInfo } from "./process-identity.ts";

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_COMMAND_LINE_INFORMATION = 60;
/** 100 ns ticks between 1601-01-01 and 1970-01-01, in ms. */
const EPOCH_DELTA_MS = 11_644_473_600_000n;

type Api = {
  openProcess: (access: number, inherit: number, pid: number) => unknown;
  closeHandle: (handle: unknown) => number;
  getProcessTimes: (handle: unknown, c: unknown, e: unknown, k: unknown, u: unknown) => number;
  query: (handle: unknown, cls: number, out: unknown, size: number, ret: unknown) => number;
  ptr: (view: Uint8Array | BigUint64Array | Uint32Array) => unknown;
};

let api: Api | null | undefined;

function load(): Api | null {
  if (api !== undefined) return api;
  try {
    // Loaded on the first Windows read only: no other platform and no other command pays for it.
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const { FFIType, dlopen, ptr } = ffi;
    const k = dlopen("kernel32.dll", {
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
      GetProcessTimes: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
    const n = dlopen("ntdll.dll", {
      NtQueryInformationProcess: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
    api = {
      openProcess: (a, i, p) => k.symbols.OpenProcess(a, i, p),
      closeHandle: (h) => k.symbols.CloseHandle(h as never),
      getProcessTimes: (h, c, e, kk, u) =>
        k.symbols.GetProcessTimes(h as never, c as never, e as never, kk as never, u as never),
      query: (h, cls, out, size, ret) =>
        n.symbols.NtQueryInformationProcess(h as never, cls, out as never, size, ret as never),
      ptr: (v) => ptr(v),
    };
  } catch {
    api = null;
  }
  return api;
}

/** The process's command line and start time, or undefined when this path cannot tell. */
export function readWindowsNative(pid: number): ProcessInfo | undefined {
  const a = load();
  if (a === null) return undefined;
  const handle = a.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!handle) return undefined;
  try {
    const times = new BigUint64Array(4); // creation, exit, kernel, user
    const slot = (i: number) => a.ptr(times.subarray(i, i + 1));
    if (a.getProcessTimes(handle, slot(0), slot(1), slot(2), slot(3)) === 0) return undefined;
    const startedAt = Number((times[0] ?? 0n) / 10_000n - EPOCH_DELTA_MS);
    // A UNICODE_STRING (length, maximum length, buffer pointer) followed by its characters.
    const buf = new Uint8Array(16 * 1024);
    const returned = new Uint32Array(1);
    const status = a.query(
      handle,
      PROCESS_COMMAND_LINE_INFORMATION,
      a.ptr(buf),
      buf.length,
      a.ptr(returned),
    );
    if (status < 0) return undefined;
    const view = new DataView(buf.buffer);
    const bytes = view.getUint16(0, true);
    const offset = Number(view.getBigUint64(8, true) - BigInt(a.ptr(buf) as number | bigint));
    if (offset < 16 || offset + bytes > buf.length) return undefined;
    const commandLine = Buffer.from(buf.buffer, offset, bytes).toString("utf16le");
    if (commandLine === "" || !Number.isFinite(startedAt)) return undefined;
    return { commandLine, startedAt };
  } finally {
    a.closeHandle(handle);
  }
}
