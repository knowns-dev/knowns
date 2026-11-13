// Port of internal/lsp/uri.go.
import { realpathSync } from "node:fs";
import { normalize, resolve, sep } from "node:path";

const isWindows = process.platform === "win32";

/** PathFromFileURI: a file:// URI to a filesystem path; anything else is returned unchanged. */
export function pathFromFileURI(uri: string): string {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return uri;
  }
  if (u.protocol !== "file:") return uri;
  let p: string;
  try {
    p = decodeURIComponent(u.pathname);
  } catch {
    return uri;
  }
  if (isWindows && p.length >= 3 && p[0] === "/" && p[2] === ":") p = p.slice(1);
  return isWindows ? p.replaceAll("/", sep) : p;
}

function escapeURIPath(p: string): string {
  // url.URL{Path}.String() escapes everything outside the RFC 3986 path set.
  return p
    .split("/")
    .map((seg) =>
      encodeURIComponent(seg).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/")
    .replaceAll("%3A", ":")
    .replaceAll("%40", "@")
    .replaceAll("%24", "$")
    .replaceAll("%26", "&")
    .replaceAll("%2B", "+")
    .replaceAll("%2C", ",")
    .replaceAll("%3B", ";")
    .replaceAll("%3D", "=");
}

export function canonicalAbsPath(path: string): string {
  let abs: string;
  try {
    abs = resolve(path);
  } catch {
    abs = path;
  }
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

/** FileURI: a filesystem path to a file:// URI (symlinks resolved when the path exists). */
export function fileURI(path: string): string {
  const abs = canonicalAbsPath(path);
  let slashed = abs.replaceAll("\\", isWindows ? "/" : "\\");
  if (isWindows && slashed.length >= 2 && slashed[1] === ":") slashed = `/${slashed}`;
  return `file://${escapeURIPath(slashed)}`;
}

export function sameFileURI(uri: string, path: string): boolean {
  const uriPath = pathFromFileURI(uri);
  let c1 = normalize(canonicalAbsPath(uriPath));
  let c2 = normalize(canonicalAbsPath(path));
  if (isWindows) {
    c1 = c1.toLowerCase();
    c2 = c2.toLowerCase();
  }
  return c1 === c2;
}
