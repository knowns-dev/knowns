// Port of internal/safepath/path.go: resolve untrusted filesystem paths inside an explicit root.
//
// Rejected: empty paths, NUL bytes, Windows device prefixes (\\?\ and \\.\), absolute paths (unless
// explicitly allowed and contained), Windows volume/UNC prefixes, parent traversal, NTFS alternate
// data streams (Windows only), and symlink escapes. The check is applied to the path as written and
// again to the path after symlinks are resolved, so a link that points outside root is rejected.
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";

export class SafePathError extends Error {
  override readonly name = "SafePathError";
}

/** filepath.Clean / filepath.Join: normalized, without a trailing separator (Node keeps it). */
function clean(path: string): string {
  const n = normalize(path);
  if (n.length > 1 && (n.endsWith("/") || n.endsWith("\\")) && parse(n).root !== n) {
    return n.slice(0, -1);
  }
  return n;
}

const WINDOWS_VOLUME = /^[A-Za-z]:/;
const isWindows = () => process.platform === "win32";

/** Resolve an untrusted relative path inside root. Absolute paths are rejected. */
export function resolveSafe(root: string, untrusted: string): string {
  return resolveInternal(root, untrusted, false);
}

/** Resolve a project path inside root. Native absolute paths are accepted only when contained. */
export function resolveProject(root: string, untrusted: string): string {
  return resolveInternal(root, untrusted, true);
}

/** resolveProject plus canonical symlink resolution, for policy checks on the final target. */
export function resolveProjectReal(root: string, untrusted: string): string {
  return resolveProspectivePath(resolveInternal(root, untrusted, true));
}

function resolveInternal(root: string, untrusted: string, allowContainedAbsolute: boolean): string {
  if (untrusted.trim() === "") throw new SafePathError("path is required");
  if (untrusted.includes("\0")) throw new SafePathError("path contains a NUL byte");

  const normalized = untrusted.replaceAll("\\", "/");
  if (normalized.startsWith("//?/") || normalized.startsWith("//./")) {
    throw new SafePathError("path must not use a Windows device prefix");
  }
  if (normalized.startsWith("/") && !allowContainedAbsolute) {
    throw new SafePathError("path must be relative");
  }
  const windowsAbsolute = WINDOWS_VOLUME.test(normalized) || normalized.startsWith("//");
  if (windowsAbsolute && !(allowContainedAbsolute && isWindows())) {
    throw new SafePathError("path must not use a volume or UNC prefix");
  }
  // filepath.FromSlash: on Windows "/" becomes "\"; elsewhere it is unchanged.
  const nativePath = isWindows() ? normalized.replaceAll("/", "\\") : normalized;
  if (windowsAbsolute && allowContainedAbsolute && isWindows() && !isAbsolute(nativePath)) {
    throw new SafePathError("path must not use a drive-relative prefix");
  }
  const segments = normalized.split("/");
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as string;
    if (segment === "..") throw new SafePathError("path must not contain parent traversal");
    // A colon outside the leading drive volume is an NTFS alternate data stream delimiter.
    const leadingDrive = i === 0 && windowsAbsolute && WINDOWS_VOLUME.test(segment);
    if (isWindows() && segment.includes(":") && !leadingDrive) {
      throw new SafePathError("path must not use an alternate data stream");
    }
  }

  const rootAbs = clean(resolve(root));
  let candidate: string;
  if (isAbsolute(nativePath)) {
    if (!allowContainedAbsolute) throw new SafePathError("path must be relative");
    candidate = clean(nativePath);
  } else {
    candidate = clean(join(rootAbs, nativePath));
  }
  requireWithin(rootAbs, candidate);
  resolveWithin(rootAbs, candidate);
  return candidate;
}

function resolveWithin(root: string, candidate: string): string {
  const rootResolved = resolveProspectivePath(root);
  const candidateResolved = resolveProspectivePath(candidate);
  try {
    requireWithin(rootResolved, candidateResolved);
  } catch (e) {
    throw new SafePathError(`path escapes root through a symlink: ${(e as Error).message}`);
  }
  return candidateResolved;
}

/**
 * resolveProspectivePath resolves symlinks in the longest existing prefix of `path` and appends
 * the not-yet-existing remainder, so a path that will be created is checked as it will resolve.
 */
export function resolveProspectivePath(path: string): string {
  let existing = clean(path);
  for (;;) {
    try {
      lstatSync(existing);
      break;
    } catch (e) {
      if (
        (e as NodeJS.ErrnoException).code !== "ENOENT" &&
        (e as NodeJS.ErrnoException).code !== "ENOTDIR"
      ) {
        throw new SafePathError(`inspect path: ${(e as Error).message}`);
      }
      const parent = dirname(existing);
      if (parent === existing) throw new SafePathError("path has no existing ancestor");
      existing = parent;
    }
  }
  const resolvedExisting = realpathSync(existing);
  const rel = relative(existing, path);
  return rel === "" ? resolvedExisting : clean(join(resolvedExisting, rel));
}

function requireWithin(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === ".." || isAbsolute(rel) || rel.startsWith(`..${sep}`)) {
    throw new SafePathError("path escapes allowed root");
  }
}
