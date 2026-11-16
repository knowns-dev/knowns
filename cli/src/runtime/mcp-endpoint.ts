// The daemon's MCP endpoint: where it listens and how a proxy finds it. The contract is the
// "Daemon MCP endpoint: handshake contract" section of @doc/specs/2026-11-16/mcp-thin-proxy.
//
// A proxy reads the descriptor file and never computes names. The endpoint is scoped to the
// version (the descriptor file name and the socket name both carry it), so a proxy only ever
// finds a daemon of its own version.
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { VERSION } from "../version.ts";
import { ENV_RUNTIME_ROOT, nowString, runtimeRoot } from "./queue.ts";

export const PROXY_PROTOCOL = 1;
const isWindows = process.platform === "win32";

export interface EndpointDescriptor {
  proxy_protocol: number;
  version: string;
  kind: "unix_socket" | "windows_pipe";
  address: string;
  token: string;
  pid: number;
  started_at: string;
}

/** The version as it appears in file names: anything outside A-Za-z0-9._+- becomes `_`. */
export function versionToken(version: string): string {
  return version.replace(/[^A-Za-z0-9._+-]/g, "_");
}

export function descriptorDir(root: string = runtimeRoot()): string {
  return join(root, "mcp");
}

export function descriptorPath(version: string = VERSION, root: string = runtimeRoot()): string {
  return join(descriptorDir(root), `endpoint-${versionToken(version)}.json`);
}

const shortHash = (parts: string[], n: number): string =>
  createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, n);

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** Where a daemon of `version` serving this runtime root listens. */
export function endpointAddress(
  version: string = VERSION,
  root: string = runtimeRoot(),
): { kind: EndpointDescriptor["kind"]; address: string; dir?: string } {
  if (isWindows) {
    return {
      kind: "windows_pipe",
      address: `\\\\.\\pipe\\knowns-mcp-${shortHash([root.toLowerCase(), version], 16)}`,
    };
  }
  const uid = currentUid();
  const dir = join(tmpdir(), `knowns-mcp-${uid ?? "user"}`);
  return {
    kind: "unix_socket",
    address: join(dir, `${shortHash([root, version], 12)}.sock`),
    dir,
  };
}

/** Throws when a directory that must be private to this user is not. */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (isWindows) return;
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a directory`);
  const uid = currentUid();
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`${dir} belongs to another user (uid ${st.uid}); refusing to listen there`);
  }
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/** On Windows the pipe is not a trust boundary, so the token file must sit in the user's profile. */
function checkDescriptorLocation(root: string): void {
  if (!isWindows) return;
  if ((process.env[ENV_RUNTIME_ROOT] ?? "").trim() !== "") return;
  const home = homedir();
  const rel = relative(resolve(home).toLowerCase(), resolve(root).toLowerCase());
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`runtime root ${root} is outside the user profile; refusing to write a token`);
  }
}

/** Removes a socket nobody listens on; refuses when a live daemon holds it. */
async function freeSocket(path: string): Promise<void> {
  if (!existsSync(path)) return;
  // Only a refused connection proves nobody listens: a daemon too busy to accept in time still
  // owns its socket, so a timeout counts as alive and the path is left alone.
  const alive = await new Promise<boolean>((done) => {
    const sock = net.connect({ path });
    const timer = setTimeout(() => {
      sock.destroy();
      done(true);
    }, 1000);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      done(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
  if (alive) throw new Error(`MCP endpoint already active: ${path}`);
  rmSync(path, { force: true });
}

export interface ListenResult {
  server: net.Server;
  descriptor: EndpointDescriptor;
}

/** Starts listening and publishes the descriptor. The caller attaches the connection handler. */
export async function listenMcpEndpoint(
  onConnection: (sock: net.Socket) => void,
  opts: { version?: string; root?: string } = {},
): Promise<ListenResult> {
  const version = opts.version ?? VERSION;
  const root = opts.root ?? runtimeRoot();
  // A caller that names the root itself has made the choice; the default must sit in the profile.
  if (opts.root === undefined) checkDescriptorLocation(root);
  const ep = endpointAddress(version, root);
  if (ep.dir) {
    ensurePrivateDir(ep.dir);
    await freeSocket(ep.address);
  }
  const server = net.createServer({ allowHalfOpen: true }, onConnection);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ path: ep.address }, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  if (!isWindows) {
    try {
      chmodSync(ep.address, 0o600);
    } catch (e) {
      server.close();
      throw new Error(`cannot restrict ${ep.address}: ${(e as Error).message}`);
    }
  }
  const descriptor: EndpointDescriptor = {
    proxy_protocol: PROXY_PROTOCOL,
    version,
    kind: ep.kind,
    address: ep.address,
    token: randomBytes(32).toString("hex"),
    pid: process.pid,
    started_at: nowString(),
  };
  try {
    writeDescriptor(descriptor, root);
  } catch (e) {
    server.close();
    throw e;
  }
  return { server, descriptor };
}

/** Atomic, owner-only: a reader sees the old file or the whole new one, never a partial token. */
export function writeDescriptor(d: EndpointDescriptor, root: string = runtimeRoot()): void {
  ensurePrivateDir(descriptorDir(root));
  const path = descriptorPath(d.version, root);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(d)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function readDescriptor(
  version: string = VERSION,
  root: string = runtimeRoot(),
): EndpointDescriptor | undefined {
  try {
    const d = JSON.parse(readFileSync(descriptorPath(version, root), "utf8")) as EndpointDescriptor;
    return typeof d.address === "string" && typeof d.token === "string" ? d : undefined;
  } catch {
    return undefined;
  }
}

/** Removes the descriptor only when it is still ours (a newer daemon may have replaced it). */
export function removeDescriptor(d: EndpointDescriptor, root: string = runtimeRoot()): void {
  const cur = readDescriptor(d.version, root);
  if (cur && cur.token !== d.token) return;
  rmSync(descriptorPath(d.version, root), { force: true });
  if (d.kind === "unix_socket") rmSync(d.address, { force: true });
}
