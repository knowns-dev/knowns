// Go's error text, reproduced once for every layer that prints it (D6 byte parity): fs errors
// ("<op> <path>: <reason>", with Windows system messages where Go uses them) and net/http
// transport errors. Go formats these from errno and syscall tables; Node gives a bare code, so
// the tables below map the codes the ported paths can hit. Unknown codes fall back to Node's
// message, which keeps the failure visible rather than inventing Go text for it.
//
// This module imports nothing from the app, so storage, search, domain, runtime, MCP and the
// server can all use it.

const WINDOWS = process.platform === "win32";

/** syscall.Errno.Error() on unix (and Go's own errno text for codes Windows shares). */
const UNIX_REASON: Readonly<Record<string, string>> = {
  ENOENT: "no such file or directory",
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  ENOTDIR: "not a directory",
  EISDIR: "is a directory",
  EEXIST: "file exists",
  ENOTEMPTY: "directory not empty",
  ELOOP: "too many levels of symbolic links",
  EROFS: "read-only file system",
};

/** The Windows system messages Go prints for the same failures (FormatMessage text). */
const WINDOWS_REASON: Readonly<Record<string, string>> = {
  ENOENT: "The system cannot find the file specified.",
  ENOTDIR: "The system cannot find the path specified.",
  EACCES: "Access is denied.",
  EPERM: "Access is denied.",
  EEXIST: "Cannot create a file when that file already exists.",
  ENOTEMPTY: "The directory is not empty.",
};

/** ERROR_FILE_NOT_FOUND vs ERROR_PATH_NOT_FOUND: which one Windows reports for a missing path. */
export const WINDOWS_FILE_NOT_FOUND = "The system cannot find the file specified.";
export const WINDOWS_PATH_NOT_FOUND = "The system cannot find the path specified.";

function codeOf(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A *fs.PathError as Go prints it for an explicit op and path: "<op> <path>: <reason>". On
 * Windows Go prints the system message, lstat is GetFileAttributesEx, and a missing parent while
 * creating a directory is ERROR_PATH_NOT_FOUND.
 */
export function goFsError(op: string, path: string, e: unknown): Error {
  const code = codeOf(e);
  if (WINDOWS && code !== undefined) {
    const reason = WINDOWS_REASON[code];
    if (reason !== undefined) {
      const winOp = op === "lstat" ? "GetFileAttributesEx" : op;
      const finalReason = op === "mkdir" && code === "ENOENT" ? WINDOWS_PATH_NOT_FOUND : reason;
      return new Error(`${winOp} ${path}: ${finalReason}`);
    }
  }
  const reason = code === undefined ? undefined : UNIX_REASON[code];
  return new Error(`${op} ${path}: ${reason ?? messageOf(e)}`);
}

/**
 * A *fs.PathError rendered from the Node error's own syscall and path ("open <path>: <reason>"),
 * for call sites that do not know the op. Uses Go's errno text on every platform; Go's Windows
 * os.OpenFile on a directory reports EISDIR, which Bun surfaces as EEXIST from CreateFile.
 */
export function goFsMessage(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  const code = WINDOWS && err.code === "EEXIST" && err.syscall === "open" ? "EISDIR" : err.code;
  const reason = code === undefined ? undefined : UNIX_REASON[code];
  if (reason !== undefined && err.syscall !== undefined && err.path !== undefined) {
    return `${err.syscall} ${err.path}: ${reason}`;
  }
  return messageOf(e);
}

/**
 * The reason Go prints when opening a path that does not exist. On Windows it depends on whether
 * the parent directory exists (FILE_NOT_FOUND) or not (PATH_NOT_FOUND).
 */
export function goNotExistReason(parentExists: boolean): string {
  if (!WINDOWS) return UNIX_REASON.ENOENT as string;
  return parentExists ? WINDOWS_FILE_NOT_FOUND : WINDOWS_PATH_NOT_FOUND;
}

// --- net/http ------------------------------------------------------------------------------------

/**
 * The *net.OpError tail Go prints for a refused dial. On Windows the op is ConnectEx and the
 * errno text is WSAECONNREFUSED's system message, period included.
 */
export const CONNECTION_REFUSED = WINDOWS
  ? "connectex: No connection could be made because the target machine actively refused it."
  : "connect: connection refused";

function hostPort(url: string): string {
  try {
    const u = new URL(url);
    const port = u.port !== "" ? u.port : u.protocol === "https:" ? "443" : "80";
    const host = u.hostname === "localhost" ? "[::1]" : u.hostname;
    return `${host}:${port}`;
  } catch {
    return url;
  }
}

/**
 * The *url.Error text for a failed request: `<Method> "<url>": <cause>`. fetch reports a bare
 * code, so the common failures are rendered the way Go's net/http would.
 */
export function goTransportError(method: string, url: string, err: unknown): string {
  const op = method.charAt(0).toUpperCase() + method.slice(1).toLowerCase();
  const e = err as { code?: string; name?: string; message?: string };
  let detail = e?.message ?? String(err);
  if (e?.code === "ConnectionRefused" || e?.code === "ECONNREFUSED") {
    detail = `dial tcp ${hostPort(url)}: ${CONNECTION_REFUSED}`;
  } else if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    detail = "context deadline exceeded (Client.Timeout exceeded while awaiting headers)";
  }
  return `${op} "${url}": ${detail}`;
}

// --- os/exec -------------------------------------------------------------------------------------

/** exec.ErrNotFound's text; Windows names the variable %PATH%. */
export const EXEC_NOT_FOUND = WINDOWS
  ? "executable file not found in %PATH%"
  : "executable file not found in $PATH";

/** The *exec.Error exec.LookPath returns for a missing binary: `exec: "<name>": <ErrNotFound>`. */
export function goLookPathError(name: string): string {
  return `exec: ${JSON.stringify(name)}: ${EXEC_NOT_FOUND}`;
}
