// Port of internal/qdrantruntime/installer.go: the pinned, checksum-verified install of the managed
// Qdrant binary under ~/.knowns/runtime/qdrant. Behaviour, on-disk layout (bin/qdrant, the
// `.previous` backup, install.json) and error texts follow Go. The download goes through an
// injectable fetch, and the platform through goos/goarch, the same seams Go's Installer exposes
// (HTTPClient, GOOS, GOARCH, Mirror).
//
// Go ships no Windows artifact: on windows/* the installer fails with Go's unsupported-platform
// error and the user points Knowns at an external Qdrant. The zip branch of extractBinary is kept
// because Go keeps it, but no pinned artifact reaches it.

import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import { STATUS_CODES } from "node:http";
import { basename, join, posix } from "node:path";
import { crc32, createGunzip, inflateRawSync } from "node:zlib";
import { goFsError, goTransportError } from "../platform/goerror.ts";
import { pathsForRoot, type QdrantPaths, SUPPORTED_QDRANT_VERSION } from "./qdrant.ts";
import { isProcessAlive, sleep } from "./queue.ts";

export const MAX_QDRANT_ARCHIVE_BYTES = 512 << 20;
export const MAX_QDRANT_BINARY_BYTES = 256 << 20;

export interface QdrantArtifact {
  os: string;
  arch: string;
  filename: string;
  sha256: string;
}

// Checksums are pinned release metadata. A mirror override must serve the same artifact bytes; it
// never weakens verification.
const SUPPORTED_ARTIFACTS: Record<string, QdrantArtifact> = {
  "darwin/arm64": {
    os: "darwin",
    arch: "arm64",
    filename: "qdrant-aarch64-apple-darwin.tar.gz",
    sha256: "e790977ad8e93a9fdcd45d311c4e36e643187ff01ba3a7f6614ab8b02743e9ad",
  },
  "darwin/amd64": {
    os: "darwin",
    arch: "amd64",
    filename: "qdrant-x86_64-apple-darwin.tar.gz",
    sha256: "fac93bfd88f019afa312d9248d913a07fb68fe5b498b6927a26d699f865d9eb8",
  },
  "linux/amd64": {
    os: "linux",
    arch: "amd64",
    filename: "qdrant-x86_64-unknown-linux-gnu.tar.gz",
    sha256: "7d43068cce7477061a7bd91fd5e5e139e35cfacb09d0dcdc4f4a33ace7d782d8",
  },
  "linux/arm64": {
    os: "linux",
    arch: "arm64",
    filename: "qdrant-aarch64-unknown-linux-musl.tar.gz",
    sha256: "ed221c141e240d1443535ba44e71c965f1d2d5e702f01c52c5ad4b7fc64bb604",
  },
};

export function qdrantArtifactFor(goos: string, goarch: string): QdrantArtifact | undefined {
  return SUPPORTED_ARTIFACTS[`${goos}/${goarch}`];
}

/** The runtime.GOOS / runtime.GOARCH names for this process. */
export function currentGoPlatform(): { goos: string; goarch: string } {
  const goos = process.platform === "win32" ? "windows" : process.platform;
  const archMap: Record<string, string> = { x64: "amd64", ia32: "386" };
  return { goos, goarch: archMap[process.arch] ?? process.arch };
}

export interface QdrantInstallerOptions {
  root: string;
  /** KNOWNS_QDRANT_MIRROR: an https:// base URL or a file:// directory. */
  mirror?: string;
  fetch?: typeof fetch;
  goos?: string;
  goarch?: string;
  signal?: AbortSignal;
  /** Test seam: replaces the pinned artifact table (Go's tests swap supportedArtifacts). */
  artifacts?: Record<string, QdrantArtifact>;
}

/**
 * Not in Go: a crash between moving bin/qdrant to .previous and moving the new binary in leaves
 * only the backup. Put it back so the runtime still has a binary; the manifest check then decides
 * whether a reinstall is needed.
 */
function recoverInterruptedActivation(binaryPath: string): void {
  const backup = `${binaryPath}.previous`;
  if (statOrUndefined(binaryPath) || !statOrUndefined(backup)) return;
  try {
    renameSync(backup, binaryPath);
  } catch {
    // best effort: the install that follows replaces it anyway
  }
}

/** A pid-stamped O_EXCL lock; a lock whose holder died is taken over. Waits up to 15 minutes. */
async function acquireInstallLock(path: string, signal?: AbortSignal): Promise<() => void> {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o644 });
      return () => {
        try {
          rmSync(path, { force: true });
        } catch {
          // a leftover lock is taken over by the next installer (its pid is gone)
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw goFsError("open", path, err);
    }
    let holder = Number.NaN;
    try {
      holder = Number.parseInt(readFileSync(path, "utf8"), 10);
    } catch {
      continue; // released between our open and read
    }
    // The same pid is a live holder too: the daemon can run two installs in one process.
    if (!Number.isFinite(holder) || (holder !== process.pid && !isProcessAlive(holder))) {
      try {
        rmSync(path, { force: true });
      } catch {
        // raced with another taker; retry
      }
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`install Qdrant: another installer (pid ${holder}) holds ${path}`);
    }
    await sleep(500, signal);
  }
}

function unexpectedEof(): Error {
  return new Error("unexpected EOF");
}

export class QdrantInstaller {
  private readonly opts: QdrantInstallerOptions;

  constructor(opts: QdrantInstallerOptions) {
    this.opts = opts;
  }

  /** Installer.Install: returns the managed paths once the pinned binary is active. */
  async install(): Promise<QdrantPaths> {
    const platform = currentGoPlatform();
    const osName = this.opts.goos || platform.goos;
    const arch = this.opts.goarch || platform.goarch;
    const artifact = (this.opts.artifacts ?? SUPPORTED_ARTIFACTS)[`${osName}/${arch}`];
    if (!artifact) {
      throw new Error(
        `unsupported Qdrant platform ${osName}/${arch}; configure an external Qdrant endpoint`,
      );
    }
    const paths = pathsForRoot(this.opts.root);
    try {
      mkdirSync(paths.root, { recursive: true, mode: 0o755 });
    } catch (err) {
      throw goFsError("mkdir", paths.root, err);
    }
    // Not in Go: two installers (a reindex job and `knowns qdrant install`) can race, and the
    // loser's rename of bin/qdrant fails. A pid lock serialises them; the waiter then sees the
    // winner's install.json and returns without downloading again.
    const release = await acquireInstallLock(join(paths.root, "install.lock"), this.opts.signal);
    try {
      recoverInterruptedActivation(paths.binaryPath);
      return await this.installLocked(paths, artifact, osName);
    } finally {
      release();
    }
  }

  private async installLocked(
    paths: QdrantPaths,
    artifact: QdrantArtifact,
    osName: string,
  ): Promise<QdrantPaths> {
    const manifestPath = join(paths.root, "install.json");
    if (existsSync(manifestPath)) {
      try {
        const m = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          version?: unknown;
          sha256?: unknown;
        };
        if (
          m.version === SUPPORTED_QDRANT_VERSION &&
          typeof m.sha256 === "string" &&
          m.sha256.toLowerCase() === artifact.sha256.toLowerCase()
        ) {
          const info = statOrUndefined(paths.binaryPath);
          if (info && !info.isDirectory()) return paths;
        }
      } catch {
        // unreadable or invalid manifest: reinstall
      }
    }
    let staging: string;
    try {
      staging = mkdtempSync(join(paths.root, "install-"));
    } catch (err) {
      throw goFsError("mkdir", join(paths.root, "install-*"), err);
    }
    try {
      const archivePath = join(staging, artifact.filename);
      await this.fetchArtifact(artifact, archivePath);
      try {
        await verifySha256(archivePath, artifact.sha256);
      } catch (err) {
        throw new Error(
          `verify pinned Qdrant ${SUPPORTED_QDRANT_VERSION} checksum: ${(err as Error).message}`,
        );
      }
      let stagedBinary = join(staging, "qdrant");
      if (osName === "windows") stagedBinary += ".exe";
      try {
        await extractBinary(archivePath, stagedBinary);
      } catch (err) {
        throw new Error(`extract verified Qdrant artifact: ${(err as Error).message}`);
      }
      try {
        chmodSync(stagedBinary, 0o755);
      } catch (err) {
        throw goFsError("chmod", stagedBinary, err);
      }
      try {
        mkdirSync(paths.binDir, { recursive: true, mode: 0o755 });
      } catch (err) {
        throw goFsError("mkdir", paths.binDir, err);
      }
      const backup = `${paths.binaryPath}.previous`;
      if (statOrUndefined(paths.binaryPath)) {
        try {
          rmSync(backup, { force: true });
        } catch {
          // Go ignores this Remove error; the rename below reports the real failure.
        }
        try {
          renameSync(paths.binaryPath, backup);
        } catch (err) {
          throw new Error(
            `preserve previous Qdrant binary: ${goFsError("rename", `${paths.binaryPath} ${backup}`, err).message}`,
          );
        }
      }
      try {
        renameSync(stagedBinary, paths.binaryPath);
      } catch (err) {
        if (statOrUndefined(backup)) {
          try {
            renameSync(backup, paths.binaryPath);
          } catch {
            // best effort, as in Go
          }
        }
        throw new Error(
          `atomically activate verified Qdrant binary: ${goFsError("rename", `${stagedBinary} ${paths.binaryPath}`, err).message}`,
        );
      }
      const manifest = JSON.stringify(
        {
          version: SUPPORTED_QDRANT_VERSION,
          sha256: artifact.sha256,
          artifact: artifact.filename,
        },
        null,
        2,
      );
      try {
        // Written beside the staged files and renamed in, so a reader never sees half a manifest.
        const tmpManifest = join(staging, "install.json");
        writeFileSync(tmpManifest, manifest, { mode: 0o644 });
        chmodSync(tmpManifest, 0o644);
        renameSync(tmpManifest, manifestPath);
      } catch (err) {
        throw new Error(
          `write Qdrant install manifest: ${goFsError("open", manifestPath, err).message}`,
        );
      }
      return paths;
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  private async fetchArtifact(artifact: QdrantArtifact, dst: string): Promise<void> {
    const base = (this.opts.mirror ?? "").trim();
    let source: string;
    if (base === "") {
      source = `https://github.com/qdrant/qdrant/releases/download/v${SUPPORTED_QDRANT_VERSION}/${artifact.filename}`;
    } else {
      source = mirrorSource(base, artifact.filename);
    }
    let out: Awaited<ReturnType<typeof openFile>>;
    try {
      out = await openFile(dst, "wx", 0o600);
    } catch (err) {
      throw goFsError("open", dst, err);
    }
    try {
      if (!source.includes("://")) {
        await copyLocalMirror(source, out);
        return;
      }
      let sourceURL: URL;
      try {
        sourceURL = new URL(source);
      } catch {
        throw new Error("Qdrant download URL must not contain userinfo, query, or fragment");
      }
      if (sourceURL.username || sourceURL.password || sourceURL.search || sourceURL.hash) {
        throw new Error("Qdrant download URL must not contain userinfo, query, or fragment");
      }
      await this.download(sourceURL, out);
    } finally {
      await out.close();
    }
  }

  private async download(sourceURL: URL, out: Awaited<ReturnType<typeof openFile>>): Promise<void> {
    const doFetch = this.opts.fetch ?? fetch;
    const policy = qdrantRedirectPolicy(sourceURL);
    const via: URL[] = [];
    let current = sourceURL;
    let resp: Response;
    for (;;) {
      try {
        resp = await doFetch(current.toString(), {
          method: "GET",
          redirect: "manual",
          ...(this.opts.signal ? { signal: this.opts.signal } : {}),
        });
      } catch (err) {
        throw new Error(
          `download Qdrant (check offline/proxy/mirror settings): ${goTransportError("GET", current.toString(), err)}`,
        );
      }
      const location = resp.headers.get("location");
      if (resp.status >= 300 && resp.status < 400 && location) {
        let next: URL;
        try {
          next = new URL(location, current);
        } catch (err) {
          throw new Error(
            `download Qdrant (check offline/proxy/mirror settings): Get "${current.toString()}": ${(err as Error).message}`,
          );
        }
        try {
          if (via.length >= 10) throw new Error("stopped after 10 redirects");
          via.push(current);
          policy(next, via);
        } catch (err) {
          await resp.body?.cancel().catch(() => {});
          throw new Error(
            `download Qdrant (check offline/proxy/mirror settings): Get "${current.toString()}": ${(err as Error).message}`,
          );
        }
        await resp.body?.cancel().catch(() => {});
        current = next;
        continue;
      }
      break;
    }
    if (Math.trunc(resp.status / 100) !== 2) {
      await resp.body?.cancel().catch(() => {});
      const text = resp.statusText || STATUS_CODES[resp.status] || "";
      throw new Error(`download Qdrant from mirror returned ${`${resp.status} ${text}`.trim()}`);
    }
    const declared = resp.headers.get("content-length");
    const contentLength = declared !== null && /^\d+$/.test(declared) ? Number(declared) : -1;
    if (contentLength > MAX_QDRANT_ARCHIVE_BYTES) {
      await resp.body?.cancel().catch(() => {});
      throw new Error(`Qdrant artifact exceeds ${MAX_QDRANT_ARCHIVE_BYTES} bytes`);
    }
    let total = 0;
    if (resp.body) {
      const reader = resp.body.getReader();
      try {
        for (;;) {
          let step: Awaited<ReturnType<typeof reader.read>>;
          try {
            step = await reader.read();
          } catch (err) {
            if (this.opts.signal?.aborted) throw err;
            throw unexpectedEof();
          }
          if (step.done) break;
          total += step.value.byteLength;
          if (total > MAX_QDRANT_ARCHIVE_BYTES) {
            throw new Error(`Qdrant artifact exceeds ${MAX_QDRANT_ARCHIVE_BYTES} bytes`);
          }
          await out.write(step.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    if (contentLength >= 0 && total < contentLength && !resp.headers.get("content-encoding")) {
      throw unexpectedEof();
    }
  }
}

function statOrUndefined(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/** The mirror URL rules of Installer.fetch; returns an OS path (file mirror) or an https URL. */
function mirrorSource(base: string, filename: string): string {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(base);
  const scheme = m ? (m[1] ?? "").toLowerCase() : "";
  const rest = m ? (m[2] ?? "") : base;
  if (scheme === "file") {
    let authority = "";
    let pathPart = rest;
    if (rest.startsWith("//")) {
      const after = rest.slice(2);
      const end = after.search(/[/?#]/);
      authority = end < 0 ? after : after.slice(0, end);
      pathPart = end < 0 ? "" : after.slice(end);
    }
    if (authority !== "") {
      throw new Error("Qdrant local mirror must use a local file:// path");
    }
    pathPart = pathPart.replace(/[?#].*$/s, "");
    let path: string;
    try {
      path = decodeURIComponent(pathPart);
    } catch {
      throw new Error(`invalid Qdrant mirror URL: parse "${base}": invalid URL escape`);
    }
    if (process.platform === "win32" && path.length > 2 && path[0] === "/" && path[2] === ":") {
      path = path.slice(1);
    }
    return join(path, filename);
  }
  let u: URL | undefined;
  if (scheme === "https") {
    try {
      u = new URL(base);
    } catch (err) {
      throw new Error(`invalid Qdrant mirror URL: parse "${base}": ${(err as Error).message}`);
    }
  }
  if (scheme !== "https" || !u || !/^https:\/\/[^/?#]/i.test(base) || u.hostname === "") {
    throw new Error("Qdrant mirror must be HTTPS or file:// local path");
  }
  if (u.username || u.password || u.search || u.hash) {
    throw new Error("Qdrant HTTPS mirror URL must not contain userinfo, query, or fragment");
  }
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/${filename}`;
  return u.toString();
}

async function copyLocalMirror(source: string, out: Awaited<ReturnType<typeof openFile>>) {
  let input: Awaited<ReturnType<typeof openFile>>;
  try {
    input = await openFile(source, "r");
  } catch (err) {
    throw new Error(
      `read Qdrant local mirror ${source}: ${goFsError("open", source, err).message}`,
    );
  }
  try {
    const info = await input.stat();
    if (info.size > MAX_QDRANT_ARCHIVE_BYTES) {
      throw new Error(`Qdrant artifact exceeds ${MAX_QDRANT_ARCHIVE_BYTES} bytes`);
    }
    const chunk = Buffer.allocUnsafe(1 << 20);
    let total = 0;
    for (;;) {
      let n: number;
      try {
        n = (await input.read(chunk, 0, chunk.length, null)).bytesRead;
      } catch (err) {
        throw goFsError("read", source, err);
      }
      if (n === 0) break;
      total += n;
      if (total > MAX_QDRANT_ARCHIVE_BYTES) {
        throw new Error(`Qdrant artifact exceeds ${MAX_QDRANT_ARCHIVE_BYTES} bytes`);
      }
      await out.write(chunk, 0, n);
    }
  } finally {
    await input.close();
  }
}

/** qdrantRedirectPolicy: https only, no secrets, and only the original (or GitHub asset) host. */
export function qdrantRedirectPolicy(source: URL): (next: URL, via: readonly URL[]) => void {
  const initialHost = source.hostname.toLowerCase();
  const allowSignedReleaseAssetQuery = initialHost === "github.com";
  const allowedHosts = new Set<string>([initialHost]);
  if (allowSignedReleaseAssetQuery) allowedHosts.add("release-assets.githubusercontent.com");
  return (next, via) => {
    if (next.protocol !== "https:") {
      throw new Error("Qdrant download redirect must remain HTTPS");
    }
    const isSignedReleaseAsset =
      allowSignedReleaseAssetQuery &&
      next.hostname.toLowerCase() === "release-assets.githubusercontent.com";
    if (
      next.username ||
      next.password ||
      next.hash ||
      (next.search !== "" && !isSignedReleaseAsset)
    ) {
      throw new Error("Qdrant download redirect must not contain userinfo, query, or fragment");
    }
    if (via.length > 0 && !allowedHosts.has(next.hostname.toLowerCase())) {
      throw new Error(`Qdrant download redirect to unapproved host ${next.hostname}`);
    }
  };
}

export async function verifySha256(path: string, want: string): Promise<void> {
  const h = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  } catch (err) {
    throw goFsError("open", path, err);
  }
  const got = h.digest("hex");
  if (got.toLowerCase() !== want.toLowerCase()) {
    throw new Error(`checksum mismatch: got ${got} want ${want}`);
  }
}

export function unsafeArchivePath(name: string): boolean {
  let clean = posix.normalize(name.replaceAll("\\", "/"));
  if (clean.length > 1 && clean.endsWith("/")) clean = clean.slice(0, -1);
  const first = clean.split("/", 1)[0] ?? "";
  return clean.startsWith("/") || clean === ".." || clean.startsWith("../") || first.includes(":");
}

type Sink = Awaited<ReturnType<typeof openFile>>;

/** copyExclusiveLimited, fed by an async byte source. */
async function writeExclusive(
  dst: string,
  produce: (write: (chunk: Uint8Array) => Promise<void>) => Promise<void>,
): Promise<void> {
  let f: Sink;
  try {
    f = await openFile(dst, "wx", 0o700);
  } catch (err) {
    throw goFsError("open", dst, err);
  }
  let total = 0;
  try {
    await produce(async (chunk) => {
      total += chunk.byteLength;
      if (total > MAX_QDRANT_BINARY_BYTES) {
        throw new Error(`qdrant binary exceeds ${MAX_QDRANT_BINARY_BYTES} bytes`);
      }
      await f.write(chunk);
    });
  } catch (err) {
    await f.close();
    rmSync(dst, { force: true });
    throw err;
  }
  await f.close();
}

/** extractBinary: pull the single regular `qdrant` entry out of a .tar.gz or .zip archive. */
export async function extractBinary(archive: string, dst: string): Promise<void> {
  if (archive.endsWith(".zip")) {
    await extractZip(archive, dst);
    return;
  }
  await extractTarGz(archive, dst);
}

// ---- tar.gz -------------------------------------------------------------------------------

class ByteReader {
  private buf: Buffer = Buffer.alloc(0);
  private pos = 0;
  private done = false;
  private readonly iter: AsyncIterator<Buffer>;

  constructor(source: AsyncIterable<Buffer>) {
    this.iter = source[Symbol.asyncIterator]();
  }

  /** Ends the source early so its finally (file stream, gunzip) runs on every exit path. */
  async close(): Promise<void> {
    if (this.done) return;
    this.done = true;
    await this.iter.return?.();
  }

  private avail(): number {
    return this.buf.length - this.pos;
  }

  private async pull(): Promise<boolean> {
    if (this.done) return false;
    const step = await this.iter.next();
    if (step.done) {
      this.done = true;
      return false;
    }
    this.buf =
      this.avail() > 0 ? Buffer.concat([this.buf.subarray(this.pos), step.value]) : step.value;
    this.pos = 0;
    return true;
  }

  /** Exactly n bytes; `undefined` for a clean EOF before the first byte; throws on a short read. */
  async take(n: number): Promise<Buffer | undefined> {
    while (this.avail() < n) {
      if (!(await this.pull())) {
        if (this.avail() === 0) return undefined;
        throw unexpectedEof();
      }
    }
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Streams n bytes to the consumer in pieces, throwing on a short read. */
  async stream(n: number, consume: (chunk: Buffer) => Promise<void> | void): Promise<void> {
    let left = n;
    while (left > 0) {
      if (this.avail() === 0 && !(await this.pull())) throw unexpectedEof();
      const take = Math.min(left, this.avail());
      const piece = this.buf.subarray(this.pos, this.pos + take);
      this.pos += take;
      left -= take;
      await consume(piece);
    }
  }

  async skip(n: number): Promise<void> {
    await this.stream(n, () => {});
  }
}

const TAR_BLOCK = 512;

function tarString(block: Buffer, from: number, to: number): string {
  const slice = block.subarray(from, to);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul < 0 ? slice.length : nul).toString("utf8");
}

function tarNumber(block: Buffer, from: number, to: number): number {
  const field = block.subarray(from, to);
  if ((field[0] ?? 0) & 0x80) {
    let v = (field[0] ?? 0) & 0x7f;
    for (let i = 1; i < field.length; i++) v = v * 256 + (field[i] ?? 0);
    return v;
  }
  const text = field.toString("latin1").replace(/^[\0 ]+|[\0 ]+$/g, "");
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error("archive/tar: invalid tar header");
  return Number.parseInt(text, 8);
}

function paxRecords(data: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let rest = data.toString("utf8");
  while (rest.length > 0) {
    const sp = rest.indexOf(" ");
    if (sp < 0) throw new Error("archive/tar: invalid tar header");
    const len = Number.parseInt(rest.slice(0, sp), 10);
    const buf = Buffer.from(rest, "utf8");
    if (!Number.isFinite(len) || len <= sp || len > buf.length) {
      throw new Error("archive/tar: invalid tar header");
    }
    const record = buf.subarray(0, len).toString("utf8");
    const body = record.slice(sp + 1, -1);
    const eq = body.indexOf("=");
    if (eq > 0) out.set(body.slice(0, eq), body.slice(eq + 1));
    rest = buf.subarray(len).toString("utf8");
  }
  return out;
}

interface TarEntry {
  name: string;
  typeflag: string;
  size: number;
}

function gunzipStream(path: string): AsyncIterable<Buffer> {
  const gz = createGunzip();
  const src = createReadStream(path);
  src.on("error", (err) => gz.destroy(err));
  src.pipe(gz);
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of gz) yield chunk as Buffer;
      } catch (err) {
        throw gzipError(err);
      } finally {
        src.destroy();
        gz.destroy();
      }
    },
  };
}

function gzipError(err: unknown): Error {
  const e = err as NodeJS.ErrnoException;
  if (e.code === "ENOENT" || e.code === "EACCES" || e.code === "EISDIR") return e;
  const msg = e.message ?? "";
  if (/unexpected end of file/i.test(msg)) return unexpectedEof();
  if (/header|magic|method/i.test(msg)) return new Error("gzip: invalid header");
  return new Error("flate: corrupt input");
}

async function nextTarEntry(reader: ByteReader): Promise<TarEntry | undefined> {
  let longName: string | undefined;
  let pax = new Map<string, string>();
  for (;;) {
    const block = await reader.take(TAR_BLOCK);
    if (!block) return undefined;
    if (block.every((b) => b === 0)) {
      const second = await reader.take(TAR_BLOCK);
      if (!second || second.every((b) => b === 0)) return undefined;
      throw new Error("archive/tar: invalid tar header");
    }
    // Header checksum, with the checksum field counted as spaces (signed and unsigned sums).
    const stored = tarNumber(block, 148, 156);
    let unsigned = 0;
    let signed = 0;
    for (let i = 0; i < TAR_BLOCK; i++) {
      const b = i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
      unsigned += b;
      signed += b > 127 ? b - 256 : b;
    }
    if (stored !== unsigned && stored !== signed)
      throw new Error("archive/tar: invalid tar header");

    const typeflag = String.fromCharCode(block[156] ?? 0);
    let size = tarNumber(block, 124, 136);
    let name = tarString(block, 0, 100);
    if (tarString(block, 257, 263) === "ustar") {
      const prefix = tarString(block, 345, 500);
      if (prefix !== "") name = `${prefix}/${name}`;
    }
    const padded = (n: number) => Math.ceil(n / TAR_BLOCK) * TAR_BLOCK;
    if (typeflag === "x" || typeflag === "g" || typeflag === "L" || typeflag === "K") {
      if (size > 1 << 20) throw new Error("archive/tar: invalid tar header");
      const data = await reader.take(size);
      if (size > 0 && !data) throw unexpectedEof();
      const bytes = data ?? Buffer.alloc(0);
      const pad = padded(size) - size;
      if (pad > 0) await reader.skip(pad);
      if (typeflag === "x") pax = new Map([...pax, ...paxRecords(bytes)]);
      else if (typeflag === "L") longName = tarString(bytes, 0, bytes.length);
      continue;
    }
    if (longName !== undefined) name = longName;
    const paxPath = pax.get("path");
    if (paxPath !== undefined) name = paxPath;
    const paxSize = pax.get("size");
    if (paxSize !== undefined) {
      if (!/^\d+$/.test(paxSize)) throw new Error("archive/tar: invalid tar header");
      size = Number(paxSize);
    }
    let flag = typeflag;
    if (flag === "\0") flag = name.endsWith("/") ? "5" : "0";
    return { name, typeflag: flag, size };
  }
}

const TAR_HEADER_ONLY = new Set(["1", "2", "3", "4", "5", "6"]);

async function extractTarGz(archive: string, dst: string): Promise<void> {
  const info = statOrUndefined(archive);
  if (!info) throw goFsError("open", archive, { code: "ENOENT" });
  if (info.size === 0) throw new Error("EOF");
  const reader = new ByteReader(gunzipStream(archive));
  let found = false;
  try {
    for (;;) {
      const h = await nextTarEntry(reader);
      if (!h) break;
      const dataSize = TAR_HEADER_ONLY.has(h.typeflag) ? 0 : h.size;
      const pad = Math.ceil(dataSize / TAR_BLOCK) * TAR_BLOCK - dataSize;
      if (unsafeArchivePath(h.name)) throw new Error(`unsafe archive path ${goQuote(h.name)}`);
      if (h.typeflag === "2" || h.typeflag === "1") {
        throw new Error(`archive links are not allowed: ${goQuote(h.name)}`);
      }
      if (basename(h.name) !== "qdrant") {
        await reader.skip(dataSize + pad);
        continue;
      }
      if (h.typeflag !== "0" && h.typeflag !== "\0") {
        throw new Error("qdrant archive entry must be a regular file");
      }
      if (h.size < 0 || h.size > MAX_QDRANT_BINARY_BYTES) {
        throw new Error(`qdrant binary exceeds ${MAX_QDRANT_BINARY_BYTES} bytes`);
      }
      if (found) throw new Error("duplicate qdrant binary entries in archive");
      await writeExclusive(dst, async (write) => {
        await reader.stream(dataSize, write);
      });
      await reader.skip(pad);
      found = true;
    }
  } finally {
    await reader.close();
  }
  if (!found) throw new Error("qdrant binary missing from archive");
}

/** Go's %q for the ASCII names that appear here. */
function goQuote(s: string): string {
  return JSON.stringify(s);
}

// ---- zip ----------------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  crc: number;
  offset: number;
  regular: boolean;
}

function readZipDirectory(data: Buffer): ZipEntry[] {
  const notZip = () => new Error("zip: not a valid zip file");
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65535); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw notZip();
  const count = data.readUInt16LE(eocd + 10);
  let p = data.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > data.length || data.readUInt32LE(p) !== 0x02014b50) throw notZip();
    const creator = data.readUInt8(p + 5);
    const method = data.readUInt16LE(p + 10);
    const crc = data.readUInt32LE(p + 16);
    const compressedSize = data.readUInt32LE(p + 20);
    const uncompressedSize = data.readUInt32LE(p + 24);
    const nameLen = data.readUInt16LE(p + 28);
    const extraLen = data.readUInt16LE(p + 30);
    const commentLen = data.readUInt16LE(p + 32);
    const attrs = data.readUInt32LE(p + 38);
    const offset = data.readUInt32LE(p + 42);
    const name = data.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    let regular = !name.endsWith("/");
    if (creator === 3 || creator === 19) {
      const type = (attrs >>> 16) & 0o170000;
      if (type !== 0 && type !== 0o100000) regular = false;
    } else if (attrs & 0x10) {
      regular = false;
    }
    out.push({ name, method, compressedSize, uncompressedSize, crc, offset, regular });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function extractZip(archive: string, dst: string): Promise<void> {
  let data: Buffer;
  try {
    data = readFileSync(archive);
  } catch (err) {
    throw goFsError("open", archive, err);
  }
  let candidate: ZipEntry | undefined;
  for (const f of readZipDirectory(data)) {
    if (unsafeArchivePath(f.name)) throw new Error(`unsafe archive path ${goQuote(f.name)}`);
    const base = basename(f.name);
    if (base !== "qdrant" && base !== "qdrant.exe") continue;
    if (!f.regular) throw new Error("qdrant archive entry must be a regular file");
    if (f.uncompressedSize > MAX_QDRANT_BINARY_BYTES) {
      throw new Error(`qdrant binary exceeds ${MAX_QDRANT_BINARY_BYTES} bytes`);
    }
    if (candidate) throw new Error("duplicate qdrant binary entries in archive");
    candidate = f;
  }
  if (!candidate) throw new Error("qdrant binary missing from archive");
  const entry = candidate;
  if (data.readUInt32LE(entry.offset) !== 0x04034b50) throw new Error("zip: not a valid zip file");
  const start =
    entry.offset + 30 + data.readUInt16LE(entry.offset + 26) + data.readUInt16LE(entry.offset + 28);
  const raw = data.subarray(start, start + entry.compressedSize);
  let content: Buffer;
  if (entry.method === 0) content = raw;
  else if (entry.method === 8) {
    try {
      content = inflateRawSync(raw, { maxOutputLength: MAX_QDRANT_BINARY_BYTES + 1 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
        throw new Error(`qdrant binary exceeds ${MAX_QDRANT_BINARY_BYTES} bytes`);
      }
      throw new Error("flate: corrupt input");
    }
  } else throw new Error("zip: unsupported compression algorithm");
  await writeExclusive(dst, async (write) => {
    await write(content);
    if (content.length !== entry.uncompressedSize || crc32(content) !== entry.crc) {
      throw new Error("zip: checksum error");
    }
  });
}
