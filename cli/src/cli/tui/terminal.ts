// Where the interactive prompts read and write. Go's huh (bubbletea) opens the controlling
// terminal itself, so a piped stdin still works when /dev/tty exists and fails with a fixed
// message when it does not. This reproduces both.
import { openSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { ReadStream, WriteStream } from "node:tty";

export interface Terminal {
  input: Readable;
  output: Writable;
}

/** The errno text Go's os.PathError carries for a failed open of /dev/tty. */
function ttyOpenReason(code: string | undefined): string {
  switch (code) {
    case "ENXIO":
      return process.platform === "darwin" ? "device not configured" : "no such device or address";
    case "ENOENT":
      return "no such file or directory";
    case "EACCES":
      return "permission denied";
    default:
      return "no such device or address";
  }
}

/**
 * The terminal for a prompt. stdin/stdout when they are a terminal; otherwise /dev/tty (unix); a
 * missing /dev/tty fails with huh's message.
 */
export function openTerminal(): Terminal {
  if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
    return { input: process.stdin, output: process.stdout };
  }
  if (process.platform === "win32") {
    // Go opens the console (CONIN$) itself. A piped stdin means there is no usable console here,
    // and waiting on it would hang a script, so fail the way a missing console does.
    if (process.stdin.isTTY === true) return { input: process.stdin, output: process.stdout };
    throw new Error("huh: could not open a new TTY: open CONIN$: The handle is invalid.");
  }
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(`huh: could not open a new TTY: open /dev/tty: ${ttyOpenReason(code)}`);
  }
  return { input: new ReadStream(fd), output: new WriteStream(fd) };
}
