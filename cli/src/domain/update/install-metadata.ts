// Port of internal/util/install_metadata.go: ~/.knowns/install.json, the record the shell
// installer leaves so `knowns update` knows how it was installed.
//
// Unlike Go, load tolerates a UTF-8 byte order mark (issue #155: PowerShell's Set-Content writes
// one, and Go's encoding/json rejects it, which made `knowns update` fail with "read install
// metadata: invalid character").
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Env, userHomeDir } from "../setup/env.ts";

export interface InstallMetadata {
  method?: string;
  managedBy?: string;
  updateStrategy?: string;
  channel?: string;
  platform?: string;
  arch?: string;
  binaryPath?: string;
  /** Symlinks the shell installer placed in a PATH directory. */
  linkPaths?: string[];
  version?: string;
  installedAt?: string;
}

/** The fields in Go's struct order (the order MarshalIndent writes them). */
const FIELDS = [
  "method",
  "managedBy",
  "updateStrategy",
  "channel",
  "platform",
  "arch",
  "binaryPath",
  "linkPaths",
  "version",
  "installedAt",
] as const;

/** "" when the home directory is unknown, like Go. */
export function installMetadataPath(env: Env = process.env): string {
  try {
    const home = userHomeDir(env);
    return home === "" ? "" : join(home, ".knowns", "install.json");
  } catch {
    return "";
  }
}

/** Strips a leading UTF-8 BOM. */
export const stripBom = (text: string): string =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

/** LoadInstallMetadata: undefined when the file is absent. Throws on unreadable or invalid JSON. */
export function loadInstallMetadata(env: Env = process.env): InstallMetadata | undefined {
  const path = installMetadataPath(env);
  if (path === "") return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  const parsed: unknown = JSON.parse(stripBom(text));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("json: cannot unmarshal into Go value of type util.InstallMetadata");
  }
  const raw = parsed as Record<string, unknown>;
  const meta: InstallMetadata = {};
  for (const f of FIELDS) {
    const v = raw[f];
    if (f === "linkPaths") {
      if (Array.isArray(v)) meta.linkPaths = v.filter((x): x is string => typeof x === "string");
    } else if (typeof v === "string") {
      meta[f] = v;
    }
  }
  return meta;
}

const goArch = (arch: string): string =>
  arch === "x64" ? "amd64" : arch === "ia32" ? "386" : arch;

/** SaveInstallMetadata: fills platform, arch and installedAt when empty; two-space indent. */
export function saveInstallMetadata(
  meta: InstallMetadata | undefined,
  env: Env = process.env,
): void {
  if (!meta) return;
  const path = installMetadataPath(env);
  if (path === "") return;
  if (!meta.platform) meta.platform = process.platform === "win32" ? "windows" : process.platform;
  if (!meta.arch) meta.arch = goArch(process.arch);
  if (!meta.installedAt) meta.installedAt = new Date().toISOString();
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) {
    const v = meta[f];
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    out[f] = v;
  }
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o644 });
}

/** IsScriptManaged. */
export function isScriptManaged(meta: InstallMetadata | undefined): boolean {
  if (!meta) return false;
  return (
    (meta.method ?? "").toLowerCase() === "script" ||
    (meta.updateStrategy ?? "").toLowerCase() === "self-update"
  );
}
