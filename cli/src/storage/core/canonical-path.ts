// Port of internal/util/path.go CanonicalPath.
//
// Windows and the default macOS filesystem are case-insensitive, so two spellings of one folder
// compare as different strings. Resolving each component against its parent's directory listing
// collapses them onto the on-disk spelling without branching on the OS: where the filesystem is
// case-sensitive the exact spelling matches first, so distinct directories keep their own paths.
import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, parse, resolve, sep } from "node:path";

/** os.SameFile: same device and inode (bigint stats keep 64-bit inodes exact on Windows). */
function sameFile(a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function lstatBig(path: string) {
  try {
    return lstatSync(path, { bigint: true });
  } catch {
    return undefined;
  }
}

function entriesOf(dir: string): string[] | undefined {
  try {
    return readdirSync(dir);
  } catch {
    return undefined;
  }
}

/**
 * onDiskName resolves `name` against the entries of `dir`: an exact match always wins; any other
 * match must be proved the same file, so a missing name never resolves to a differently cased
 * sibling on a case-sensitive filesystem. An alias the listing never names (a Windows 8.3 short
 * name) is resolved by finding the entry that is the same file.
 */
function onDiskName(dir: string, name: string): string | undefined {
  const entries = entriesOf(dir);
  if (!entries) return undefined;

  let folded: string | undefined;
  const lowerName = name.toLowerCase();
  for (const entry of entries) {
    if (entry === name) return name;
    if (folded === undefined && entry.toLowerCase() === lowerName) folded = entry;
  }

  const requested = lstatBig(join(dir, name));
  if (!requested) return undefined;

  if (folded !== undefined) {
    const existing = lstatBig(join(dir, folded));
    if (!existing || !sameFile(requested, existing)) return undefined;
    return folded;
  }

  for (const entry of entries) {
    const existing = lstatBig(join(dir, entry));
    if (existing && sameFile(requested, existing)) return entry;
  }
  return undefined;
}

function canonicalVolume(volume: string): string {
  return /^[A-Za-z]:$/.test(volume) ? volume.toUpperCase() : volume;
}

/**
 * CanonicalPath: the path with every component spelled the way it exists on disk. A component that
 * cannot be resolved keeps the caller's spelling and the walk carries on below it.
 */
export function canonicalPath(path: string): string {
  if (path === "") return path;
  const abs = resolve(path);
  const { root } = parse(abs);
  // Windows root is "C:\\" (volume + separator); POSIX root is "/". UNC roots keep their spelling.
  const volume = process.platform === "win32" ? root.replace(/[\\/]+$/, "") : "";
  let current = canonicalVolume(volume) + sep;
  const rest = abs.slice(root.length).replace(/^[\\/]+|[\\/]+$/g, "");
  if (rest === "") return current;
  for (const component of rest.split(sep)) {
    const match = onDiskName(current, component) ?? component;
    current = join(current, match);
  }
  return current;
}

export { isAbsolute };
