// `knowns update` (internal/cli/update.go): check the npm registry, detect how Knowns was
// installed, run the matching upgrade (self-update for the install script, brew, or a package
// manager), then re-point project MCP configs at the local binary and restart an outdated shared
// runtime.
//
// Everything that touches the network, the running binary or another process goes through
// `updateSeams`, so tests drive the whole flow against a local server and a temp "binary" without
// ever replacing the real executable or downloading a release.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type Env, lookPath, userHomeDir } from "../../domain/setup/env.ts";
import { syncProjectMcpConfigs } from "../../domain/setup/sync-steps.ts";
import {
  type InstallMetadata,
  loadInstallMetadata,
  saveInstallMetadata,
} from "../../domain/update/install-metadata.ts";
import {
  detectInstallMethodFor,
  type InstallMethod,
  resolveExecutable,
} from "../../domain/update/install-method.ts";
import {
  ENGINE_NAME,
  isLegacyLayout,
  LEGACY_LAYOUT_COMMAND,
  parseArchiveLayout,
} from "../../domain/update/layout.ts";
import { fetchLatestVersion } from "../../domain/update/notifier.ts";
import { compareVersions, normalizeVersionTag } from "../../domain/update/version.ts";
import { selfExecutable } from "../../platform/launcher.ts";
import { VERSION } from "../../version.ts";
import { type CommandContext, defineCommand } from "../core/define.ts";
import { ErrCommandCancelled } from "../core/exit.ts";
import { isTTY } from "../core/pager.ts";
import {
  renderSuccess,
  StyleBold,
  StyleDim,
  StyleInfo,
  StyleSuccess,
  StyleWarning,
} from "../core/plainoutput.ts";

const DOWNLOAD_TIMEOUT_MS = 30_000;

/** Replaceable edges of the command. The defaults are the real ones. */
export interface UpdateSeams {
  fetchLatest: () => Promise<string>;
  /** Stdout is a terminal (prompts are only offered then). */
  isTTY: () => boolean;
  /** The running executable's path. */
  executable: () => string;
  /** GOOS-style platform name. */
  goos: () => string;
  /** Run a program with inherited stdio; resolves to its exit code (null: killed or not started). */
  run: (bin: string, args: string[], env: Env) => Promise<number>;
  /** Download url to dest, throwing Go's error text on failure. */
  download: (url: string, dest: string) => Promise<void>;
  /** Unpack a .tar.gz into dir. */
  extract: (archive: string, dir: string, env: Env) => Promise<void>;
  releaseUrl: (version: string) => string;
  /** Ask a yes/no question (default yes); undefined means cancelled. */
  confirm: (question: string) => Promise<boolean | undefined>;
  /** Ask for an install method; undefined means cancelled. */
  chooseMethod: (
    options: Array<{ method: InstallMethod; label: string; cmd: string }>,
  ) => Promise<InstallMethod | undefined>;
  /** Stop an outdated shared runtime. */
  restartRuntime: (targetVersion: string) => Promise<void>;
}

const methodLabel = (m: InstallMethod): string =>
  ({
    script: "Install script",
    brew: "Homebrew",
    npm: "npm",
    bun: "bun",
    pnpm: "pnpm",
    yarn: "yarn",
    unknown: "unknown",
  })[m];

function releasePlatform(goos: string): string {
  const os =
    goos === "darwin" ? "darwin" : goos === "linux" ? "linux" : goos === "windows" ? "win" : "";
  if (os === "") throw new Error(`unsupported platform: ${goos}`);
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : "";
  if (arch === "") {
    throw new Error(`unsupported architecture: ${process.arch === "ia32" ? "386" : process.arch}`);
  }
  return `${os}-${arch}`;
}

export function releaseArtifactUrl(version: string, goos: string): string {
  return `https://github.com/knowns-dev/knowns/releases/download/${version}/knowns-${releasePlatform(goos)}.tar.gz`;
}

async function defaultDownload(url: string, dest: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (resp.status !== 200) {
      throw new Error(`unexpected status: ${resp.status} ${resp.statusText}`.trimEnd());
    }
    if (!resp.body) throw new Error("unexpected status: empty body");
    await pipeline(Readable.fromWeb(resp.body as never), createWriteStream(dest));
  } finally {
    clearTimeout(timer);
  }
}

function defaultRun(bin: string, args: string[], env: Env): Promise<number> {
  return new Promise((resolveRun) => {
    const child = spawn(bin, args, { stdio: "inherit", env: env as NodeJS.ProcessEnv });
    child.on("error", () => resolveRun(-1));
    child.on("close", (code) => resolveRun(code ?? -1));
  });
}

async function defaultRestartRuntime(targetVersion: string): Promise<void> {
  const queue = await import("../../runtime/queue.ts");
  let status: ReturnType<typeof queue.loadStatus>;
  try {
    status = queue.loadStatus();
  } catch {
    return;
  }
  if (!status.running) return;
  const target = targetVersion.replace(/^v/, "");
  const running = (status.version ?? "").replace(/^v/, "");
  if (status.version === undefined || status.version === "" || running === target) return;
  try {
    queue.requestShutdown(5000);
    return;
  } catch {
    // fall through to the pid file
  }
  try {
    const parsed = Number.parseInt(readFileSync(queue.pidFile(), "utf8").trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) process.kill(parsed);
  } catch {
    // no pid file, or the process is gone
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!queue.isRunning()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out waiting for shared runtime to stop after update");
}

function errUpdateCancelled(): Error {
  return new Error(`update cancelled: ${ErrCommandCancelled.message}`, {
    cause: ErrCommandCancelled,
  });
}

/** Marks the "update deferred" outcome: guidance was printed, nothing failed. */
class UpdateDeferred extends Error {}

export const updateSeams: UpdateSeams = {
  fetchLatest: () => fetchLatestVersion(),
  isTTY: () => isTTY(),
  executable: () => selfExecutable(),
  goos: () => (process.platform === "win32" ? "windows" : process.platform),
  run: defaultRun,
  download: defaultDownload,
  extract: async (archive, dir, env) => {
    const tar = lookPath("tar", env);
    if (!tar) throw new Error("tar not found in PATH");
    const code = await defaultRun(tar, ["-xzf", archive, "-C", dir], env);
    if (code !== 0) throw new Error(`exit status ${code}`);
  },
  releaseUrl: (version) => releaseArtifactUrl(version, updateSeams.goos()),
  confirm: async (question) => {
    const { createPrompter, isUserAborted } = await import("../tui/prompter.ts");
    try {
      return await createPrompter().confirm({ title: question.trim(), value: true });
    } catch (e) {
      if (isUserAborted(e)) return undefined;
      throw e;
    }
  },
  chooseMethod: async (options) => {
    const { createPrompter, isUserAborted } = await import("../tui/prompter.ts");
    try {
      const picked = await createPrompter().select({
        title: "Choose your install method:",
        options: options.map((o) => ({ label: `${o.label} (${o.cmd})`, value: o.method })),
        value: options[0]?.method ?? "script",
      });
      return picked as InstallMethod;
    } catch (e) {
      if (isUserAborted(e)) return undefined;
      throw e;
    }
  },
  restartRuntime: defaultRestartRuntime,
};

const scriptInstallCmd = (goos: string): string =>
  goos === "windows"
    ? "irm https://knowns.sh/script/install.ps1 | iex"
    : "curl -fsSL https://knowns.sh/script/install | sh";

function recommendedUpdateCommand(method: InstallMethod, cmd: string): string {
  if (method === "brew") return `brew update && HOMEBREW_NO_AUTO_UPDATE=1 ${cmd}`;
  return cmd !== "" ? cmd : "knowns update";
}

const packageManagerNeedsExternalShell = (goos: string, m: InstallMethod): boolean =>
  goos === "windows" && (m === "npm" || m === "bun" || m === "pnpm" || m === "yarn");

function isUserWritable(path: string): boolean {
  const probe = join(dirname(path), ".knowns-write-test");
  try {
    writeFileSync(probe, "ok", { mode: 0o644 });
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function samePath(a: string, b: string, goos: string): boolean {
  const ca = resolve(a);
  const cb = resolve(b);
  return goos === "windows" ? ca.toLowerCase() === cb.toLowerCase() : ca === cb;
}

function inferScriptInstallMetadata(seams: UpdateSeams, env: Env): InstallMetadata | undefined {
  const exeRaw = seams.executable();
  if (exeRaw === "") return undefined;
  const exe = resolveExecutable(exeRaw);
  let home: string;
  try {
    home = userHomeDir(env);
  } catch {
    return undefined;
  }
  if (home === "") return undefined;
  const defaultDir = resolveExecutable(join(home, ".knowns", "bin"));
  if (!samePath(dirname(exe), defaultDir, seams.goos())) return undefined;
  return {
    method: "script",
    managedBy: "knowns-script",
    updateStrategy: "self-update",
    channel: "stable",
    binaryPath: exe,
    version: VERSION,
  };
}

function findFile(root: string, match: (name: string) => boolean): string {
  const walk = (dir: string): string | undefined => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (match(entry.toLowerCase())) return full;
    }
    return undefined;
  };
  const found = walk(root);
  if (!found) throw new Error("updated binary not found in release artifact");
  return found;
}

/** One binary to install: src is the new file, dest where it goes. An optional one only warns. */
export interface BinarySwap {
  src: string;
  dest: string;
  optional?: boolean;
}

export interface SwapSeams {
  rename?: (from: string, to: string) => void;
  remove?: (path: string) => void;
  warn?: (message: string) => void;
}

/**
 * Install several binaries as one unit (knowns and its proxy). Every new file is first written
 * next to its destination, then swapped in; if a required swap fails, the ones already done are
 * put back, so an update never leaves a new knowns beside an old proxy or no knowns at all. A
 * failure on an optional binary (the proxy) is only a warning: it keeps its old file, which still
 * works because a proxy that finds no daemon of its own version falls back to in-process.
 * Windows cannot overwrite or delete a running exe but can rename it, so the old file is moved
 * aside; a previous .old that is still locked (an older process still runs from it) is not an
 * error, the new one just gets a unique name and `sweepOldBinaries` removes them later.
 */
export function replaceBinaries(items: BinarySwap[], goos: string, seams: SwapSeams = {}): void {
  const rename = seams.rename ?? renameSync;
  const remove = seams.remove ?? ((p: string) => rmSync(p, { force: true }));
  const warn = seams.warn ?? (() => {});
  const staged: Array<BinarySwap & { tmp: string }> = [];
  const dropTmp = (): void => {
    for (const it of staged) rmSync(it.tmp, { force: true });
  };
  for (const it of items) {
    const tmp = `${it.dest}.tmp`;
    try {
      mkdirSync(dirname(it.dest), { recursive: true, mode: 0o755 });
      writeFileSync(tmp, readFileSync(it.src), { mode: 0o755 });
      staged.push({ ...it, tmp });
    } catch (e) {
      rmSync(tmp, { force: true });
      if (!it.optional) {
        dropTmp();
        throw e;
      }
      warn(`could not stage ${basename(it.dest)}: ${(e as Error).message}`);
    }
  }

  const undo: Array<() => void> = [];
  const cleanup: string[] = [];
  try {
    for (const it of staged) {
      try {
        const aside = existsSync(it.dest) ? asideFor(it.dest, goos, remove) : undefined;
        if (aside !== undefined) {
          if (goos === "windows") rename(it.dest, aside);
          else {
            try {
              linkSync(it.dest, aside);
            } catch {
              copyFileSync(it.dest, aside);
            }
          }
        }
        try {
          rename(it.tmp, it.dest);
        } catch (e) {
          // The rename is atomic off Windows, so only Windows has lost its destination.
          if (aside !== undefined && goos === "windows") {
            try {
              rename(aside, it.dest);
            } catch {
              // the error below still reports the failure; the aside file keeps the old binary
            }
          } else if (aside !== undefined) {
            remove(aside);
          }
          throw e;
        }
        if (aside !== undefined) {
          if (goos !== "windows") cleanup.push(aside);
          undo.push(() => {
            if (goos === "windows") remove(it.dest);
            rename(aside, it.dest);
          });
        } else {
          undo.push(() => remove(it.dest));
        }
      } catch (e) {
        if (!it.optional) throw e;
        warn(`could not replace ${basename(it.dest)}: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    for (const u of undo.reverse()) {
      try {
        u();
      } catch {
        // best effort: the aside files keep the previous binaries
      }
    }
    dropTmp();
    throw e;
  }
  dropTmp();
  for (const p of cleanup) {
    try {
      remove(p);
    } catch {}
  }
}

/** Where the old file goes: dest.old, or a unique name when a previous .old cannot be removed. */
function asideFor(dest: string, goos: string, remove: (p: string) => void): string {
  const plain = goos === "windows" ? `${dest}.old` : `${dest}.rollback`;
  try {
    remove(plain);
    return plain;
  } catch {
    return `${dest}.old.${Date.now()}`;
  }
}

/**
 * Deletes a file that is no longer part of the install (knowns-proxy, the launcher's old name; or
 * knowns-engine when an archive without a launcher is installed). On Windows a running exe cannot
 * be deleted but can be renamed, and the .old is swept by the next update.
 */
function removeInstalled(dir: string, name: string): boolean {
  const path = join(dir, name);
  if (!existsSync(path)) return false;
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    try {
      renameSync(path, `${path}.old.${Date.now()}`);
      return true;
    } catch {
      return false;
    }
  }
}

/** The retired knowns-proxy must not stay beside the new knowns: nothing would ever run it. */
export function removeStaleProxy(dir: string, goos: string): boolean {
  return removeInstalled(dir, goos === "windows" ? "knowns-proxy.exe" : "knowns-proxy");
}

/** Delete leftover dest.old / dest.old.<ts> files of a previous update; locked ones stay for later. */
export function sweepOldBinaries(dir: string): number {
  let n = 0;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!/^(knowns|kn)(-proxy|-engine)?(\.exe)?\.(old(\.\d+)?|rollback)$/i.test(name)) continue;
    try {
      rmSync(join(dir, name), { force: true });
      n++;
    } catch {}
  }
  return n;
}

/** Exported, with a rename seam, for the Windows rollback test. */
export function replaceBinary(
  src: string,
  dest: string,
  goos: string,
  rename: (from: string, to: string) => void = renameSync,
): void {
  replaceBinaries([{ src, dest }], goos, { rename });
}

/** The digest in a `<hex>  <file>` (or bare `<hex>`) checksum file, or undefined if malformed. */
export function parseReleaseChecksum(text: string): string | undefined {
  const first = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return /^[0-9a-f]{64}$/.test(first) ? first : undefined;
}

async function verifyReleaseChecksum(
  seams: UpdateSeams,
  url: string,
  archive: string,
): Promise<void> {
  const sumFile = `${archive}.sha256`;
  try {
    await seams.download(`${url}.sha256`, sumFile);
  } catch (e) {
    throw new Error(
      `download release checksum (${basename(url)}.sha256): ${(e as Error).message}; the current binary was not changed`,
    );
  }
  const expected = parseReleaseChecksum(readFileSync(sumFile, "utf8"));
  if (!expected) {
    throw new Error(
      `release checksum file ${basename(url)}.sha256 is not a sha256 digest; the current binary was not changed`,
    );
  }
  const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `release artifact checksum mismatch for ${basename(url)}: expected ${expected}, got ${actual}; the current binary was not changed`,
    );
  }
}

async function downloadAndReplaceBinary(
  seams: UpdateSeams,
  env: Env,
  url: string,
  binaryPath: string,
): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), "knowns-update-"));
  try {
    const archive = join(tmpDir, basename(url));
    try {
      await seams.download(url, archive);
    } catch (e) {
      throw new Error(`download release artifact: ${(e as Error).message}`);
    }
    // D12 (TSR-CRAT15), beyond 0.34.1, which installs whatever the download returned: verify the
    // archive against the <asset>.sha256 published next to it (package-release.ts for 1.x, shasum
    // for 0.34.x), as install.sh and the npm installer do. A missing or mismatching checksum stops
    // before extraction, so the current binary is never touched.
    await verifyReleaseChecksum(seams, url, archive);
    // D12 (TSR-CRAT15), beyond 0.34.1: extract into a directory of its own. 0.34.1 extracts next to
    // the downloaded `knowns-<platform>.tar.gz`, and its matcher also accepts `knowns-*`, so the
    // archive itself is a candidate: Go's sorted walk happens to reach `knowns` first on macOS and
    // Linux, but on Windows `knowns-win-x64.tar.gz` sorts before `knowns.exe`, and an unsorted walk
    // can pick it anywhere. Installing the archive as the binary reports "Upgrade complete." and
    // leaves a knowns that cannot run.
    const extractDir = join(tmpDir, "extracted");
    mkdirSync(extractDir);
    try {
      await seams.extract(archive, extractDir, env);
    } catch (e) {
      throw new Error(`extract release artifact: ${(e as Error).message}`);
    }
    const goos = seams.goos();
    const ext = goos === "windows" ? ".exe" : "";
    const dir = dirname(binaryPath);
    // Spec mcp-thin-proxy D10. A launcher archive has layout.json: its `knowns` is the ENGINE (so
    // a 0.34.x or 0.35.0 updater, which takes the first file named knowns, installs something that
    // runs) and the launcher has a name no older updater matches. The launcher becomes `knowns`
    // here and the engine `knowns-engine`, as one unit: a failure rolls both back.
    const items: BinarySwap[] = [];
    let split = false;
    let layoutFile: string | undefined;
    try {
      layoutFile = findFile(extractDir, (n) => n === "layout.json");
    } catch {
      layoutFile = undefined;
    }
    if (layoutFile !== undefined) {
      const layout = parseArchiveLayout(readFileSync(layoutFile, "utf8"));
      const root = dirname(layoutFile);
      const engineSrc = join(root, layout.engine.file);
      const launcherSrc = join(root, layout.launcher.file);
      if (!existsSync(engineSrc) || !existsSync(launcherSrc)) {
        throw new Error("release artifact is missing the launcher or the engine");
      }
      // The engine first: an older launcher keeps working with a newer engine, not the reverse.
      items.push({ src: engineSrc, dest: join(dir, `${ENGINE_NAME}${ext}`) });
      items.push({ src: launcherSrc, dest: binaryPath });
      // On Windows kn.exe is a copy of knowns.exe (no symlinks without privileges): keep it in step.
      const alias = join(dir, `kn${ext}`);
      if (goos === "windows" && existsSync(alias) && resolve(alias) !== resolve(binaryPath)) {
        items.push({ src: launcherSrc, dest: alias, optional: true });
      }
      split = true;
    } else {
      // An archive without a launcher (0.35 and older): the engine alone is knowns. The exact name
      // wins; the knowns-* match is only for the 0.34 Windows alias.
      const binaryName = `knowns${ext}`;
      let extracted: string;
      try {
        extracted = findFile(extractDir, (n) => n === binaryName);
      } catch {
        extracted = findFile(
          extractDir,
          (n) =>
            n.startsWith("knowns-") && !n.startsWith("knowns-proxy") && !n.startsWith(ENGINE_NAME),
        );
      }
      items.push({ src: extracted, dest: binaryPath });
    }
    sweepOldBinaries(dir);
    try {
      replaceBinaries(items, goos, {
        warn: (m) => process.stderr.write(`warning: ${m}\n`),
      });
    } catch (e) {
      throw new Error(`replace binary: ${(e as Error).message}`);
    }
    if (!split) removeInstalled(dir, `${ENGINE_NAME}${ext}`);
    removeStaleProxy(dir, goos);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * The path `knowns` has in the install: the launcher. A running engine knows itself as
 * knowns-engine, so a path taken from it is mapped to the launcher beside it (KNOWNS_LAUNCHER names
 * it exactly when a launcher started this engine).
 */
export function launcherPathFor(binaryPath: string, env: Env, goos: string): string {
  const fromLauncher = (env.KNOWNS_LAUNCHER ?? "").trim();
  if (fromLauncher !== "" && !/[\\/]node_modules[\\/]/i.test(fromLauncher)) return fromLauncher;
  const stem = basename(binaryPath)
    .replace(/\.exe$/i, "")
    .toLowerCase();
  if (stem !== ENGINE_NAME) return binaryPath;
  return join(dirname(binaryPath), goos === "windows" ? "knowns.exe" : "knowns");
}

async function runScriptManagedUpgrade(
  ctx: CommandContext,
  seams: UpdateSeams,
  meta: InstallMetadata,
): Promise<void> {
  let binaryPath = (meta.binaryPath ?? "").trim();
  if (binaryPath === "") binaryPath = resolveExecutable(seams.executable());
  binaryPath = launcherPathFor(binaryPath, ctx.env, seams.goos());
  // An npm install hard-links the platform package's binary to the npm bin entry, so one inode is
  // shared with the package manager's copy: writing it in place would corrupt both.
  if (/[\\/]node_modules[\\/]/i.test(binaryPath)) {
    throw new Error(
      `${binaryPath} belongs to a package manager (node_modules); updating it in place would corrupt the package. Run: npm i -g knowns`,
    );
  }
  if (!isUserWritable(binaryPath)) {
    throw new Error(
      `script-managed install at ${binaryPath} is not writable by the current user; reinstall to ~/.knowns/bin or set KNOWNS_INSTALL_DIR to a user-writable path`,
    );
  }
  const version = normalizeVersionTag(await seams.fetchLatest());
  if (version === "") throw new Error("could not determine latest version");
  const url = seams.releaseUrl(version);
  ctx.print(
    `${StyleBold.render("Upgrading...")} ${StyleInfo.render(scriptInstallCmd(seams.goos()))}\n`,
  );
  await downloadAndReplaceBinary(seams, ctx.env, url, binaryPath);
  meta.method = "script";
  if (!meta.managedBy) meta.managedBy = "knowns-script";
  meta.updateStrategy = "self-update";
  meta.binaryPath = binaryPath;
  meta.version = version.replace(/^v/, "");
  if (!meta.channel) meta.channel = "stable";
  try {
    saveInstallMetadata(meta, ctx.env);
  } catch (e) {
    throw new Error(`persist install metadata: ${(e as Error).message}`);
  }
  await seams.restartRuntime(version);
  ctx.print(`${StyleSuccess.render("✓")} Upgrade complete.\n`);
}

async function runHomebrewUpgrade(
  ctx: CommandContext,
  seams: UpdateSeams,
  installCmd: string,
): Promise<void> {
  const brew = lookPath("brew", ctx.env);
  if (!brew) throw new Error("brew not found in PATH — install it first or upgrade manually");
  ctx.print(
    `${StyleBold.render("Refreshing Homebrew...")} Running: ${StyleInfo.render("brew update")}\n`,
  );
  if ((await seams.run(brew, ["update"], ctx.env)) !== 0) {
    throw new Error("brew update failed: exit status 1");
  }
  const parts = installCmd
    .trim()
    .split(/\s+/)
    .filter((p) => p !== "");
  if (parts.length === 0) throw new Error("could not determine upgrade command");
  ctx.print(
    `${StyleBold.render("Upgrading...")} Running: ${StyleInfo.render(`HOMEBREW_NO_AUTO_UPDATE=1 ${installCmd}`)}\n`,
  );
  const code = await seams.run(brew, parts.slice(1), { ...ctx.env, HOMEBREW_NO_AUTO_UPDATE: "1" });
  if (code !== 0) throw new Error(`upgrade failed: exit status ${code}`);
  ctx.print(`${StyleSuccess.render("✓")} Upgrade complete.\n`);
}

async function runUpgrade(ctx: CommandContext, seams: UpdateSeams): Promise<void> {
  let meta: InstallMetadata | undefined;
  try {
    meta = loadInstallMetadata(ctx.env);
  } catch (e) {
    throw new Error(`read install metadata: ${(e as Error).message}`);
  }
  meta ??= inferScriptInstallMetadata(seams, ctx.env);

  const detected = detectInstallMethodFor(seams.executable(), { env: ctx.env });
  let method = detected.method;
  let installCmd = detected.command;
  const goos = seams.goos();

  const options = [
    { method: "script" as const, label: "Install script", cmd: scriptInstallCmd(goos) },
    { method: "brew" as const, label: "Homebrew", cmd: "brew upgrade knowns-dev/tap/knowns" },
    { method: "npm" as const, label: "npm", cmd: "npm i -g knowns" },
    { method: "bun" as const, label: "bun", cmd: "bun add -g knowns" },
    { method: "pnpm" as const, label: "pnpm", cmd: "pnpm add -g knowns" },
    { method: "yarn" as const, label: "yarn", cmd: "yarn global add knowns" },
  ];
  const choose = async (): Promise<void> => {
    if (!seams.isTTY()) {
      method = "script";
      installCmd = "knowns update";
      return;
    }
    const picked = await seams.chooseMethod(options);
    if (picked === undefined) throw errUpdateCancelled();
    method = picked;
    installCmd = options.find((o) => o.method === picked)?.cmd ?? "";
  };

  if (method !== "unknown" && seams.isTTY()) {
    ctx.print(
      `  ${StyleInfo.render("ℹ")} Detected install method: ${StyleBold.render(methodLabel(method))}\n`,
    );
    const yes = await seams.confirm("  Proceed with this method?");
    if (yes === undefined) throw errUpdateCancelled();
    if (!yes) await choose();
  }
  if (method === "unknown") {
    if (!seams.isTTY()) {
      throw new Error(
        `could not detect how knowns was installed; reinstall using one of:\n  ${scriptInstallCmd(goos)}\n  brew install knowns-dev/tap/knowns\n  npm i -g knowns\n  bun add -g knowns`,
      );
    }
    ctx.print(`  ${StyleWarning.render("⚠")} Could not detect install method.\n`);
    await choose();
  }

  if (method === "script") {
    meta ??= {};
    meta.method = "script";
    meta.managedBy = "knowns-script";
    await runScriptManagedUpgrade(ctx, seams, meta);
    return;
  }
  if (method === "brew") {
    await runHomebrewUpgrade(ctx, seams, installCmd);
    return;
  }
  if (packageManagerNeedsExternalShell(goos, method)) {
    ctx.print(
      `  ${StyleWarning.render("!")} Windows cannot safely run ${StyleBold.render(methodLabel(method))} while this knowns.exe process is active.\n`,
    );
    ctx.print("\n");
    ctx.print(
      "  Close terminals/agents that are using Knowns, then run this in a fresh PowerShell:\n",
    );
    ctx.print(`  ${StyleInfo.render(installCmd)}\n`);
    ctx.print("\n");
    ctx.print(
      `  After it finishes, run ${StyleBold.render("knowns sync")} to sync configs and rebuild indexes.\n`,
    );
    throw new UpdateDeferred();
  }

  ctx.print(`${StyleBold.render("Upgrading...")} Running: ${StyleInfo.render(installCmd)}\n`);
  const parts = installCmd
    .trim()
    .split(/\s+/)
    .filter((p) => p !== "");
  if (parts.length === 0) throw new Error("could not determine upgrade command");
  const bin = lookPath(parts[0] as string, ctx.env);
  if (!bin) throw new Error(`${parts[0]} not found in PATH — install it first or upgrade manually`);
  const code = await seams.run(bin, parts.slice(1), ctx.env);
  if (code !== 0) throw new Error(`upgrade failed: exit status ${code}`);

  meta ??= {};
  meta.method = method;
  meta.managedBy = method;
  meta.version = normalizeVersionTag(await seams.fetchLatest()).replace(/^v/, "");
  try {
    saveInstallMetadata(meta, ctx.env);
  } catch {
    // Go ignores the error.
  }
  ctx.print(`${StyleSuccess.render("✓")} Upgrade complete.\n`);
}

export default defineCommand({
  use: "update",
  short: "Update Knowns CLI to the latest version and sync project configs",
  long: `Update the Knowns CLI binary to the latest version, then sync the current
project's MCP configurations to use the local binary directly (instead of npx).

This command:
  1. Detects how Knowns was installed (Homebrew, npm, etc.)
  2. Runs the appropriate upgrade command
  3. Syncs MCP configs (.mcp.json, .kiro/settings/mcp.json) to use the local binary

Use --check to only check for updates without installing.`,
  flags: [
    {
      type: "bool",
      name: "check",
      usage: "Only check for updates without installing",
      default: false,
    },
  ],
  async run(ctx) {
    const seams = updateSeams;
    const checkOnly = ctx.flags.bool("check");

    ctx.print(`${StyleBold.render("Checking for updates...")}\n`);
    const latest = await seams.fetchLatest();
    if (latest === "") {
      throw new Error("could not reach the npm registry — check your network connection");
    }
    const current = VERSION;
    const cmp = compareVersions(latest, current);
    // Spec mcp-thin-proxy D10: an install that an older updater left as the engine alone is
    // finished by this command even when the version is current. Only an equal version: a build
    // newer than the latest release has no archive to take the launcher from.
    const finishLayout = cmp === 0 && isLegacyLayout(seams.executable(), ctx.env);
    if (cmp <= 0 && !finishLayout) {
      ctx.print(
        `  ${renderSuccess("")} Already on the latest version ${StyleBold.render(normalizeVersionTag(current))}\n`,
      );
      return;
    }
    if (finishLayout) {
      ctx.print(
        `  ${StyleInfo.render("ℹ")} Version ${StyleBold.render(normalizeVersionTag(current))} is current, but this install still has the old single-binary layout; ${checkOnly ? `run ${StyleInfo.render(LEGACY_LAYOUT_COMMAND)} to finish it` : "finishing it (launcher + engine)"}.\n`,
      );
      if (checkOnly) return;
    } else {
      ctx.print(
        `  ${StyleWarning.render("UPDATE")} → ${StyleBold.render(normalizeVersionTag(latest))} available (current ${StyleDim.render(normalizeVersionTag(current))})\n`,
      );
    }

    if (checkOnly) {
      const d = detectInstallMethodFor(seams.executable(), { env: ctx.env });
      ctx.print(`\n  Run: ${StyleInfo.render(recommendedUpdateCommand(d.method, d.command))}\n`);
      return;
    }

    ctx.print("\n");
    try {
      await runUpgrade(ctx, seams);
    } catch (e) {
      if (e instanceof UpdateDeferred) return;
      throw e;
    }

    ctx.print("\n");
    try {
      const n = syncProjectMcpConfigs(ctx.cwd, ctx.env, (label) =>
        ctx.print(`  ${StyleInfo.render("synced")} ${label}\n`),
      );
      if (n !== undefined) {
        if (n > 0)
          ctx.print(`${StyleSuccess.render("✓")} Synced ${n} MCP config(s) to use local binary.\n`);
        else ctx.print(`${StyleDim.render("·")} MCP configs already up to date.\n`);
      }
    } catch (e) {
      ctx.printErr(`Warning: MCP config sync failed: ${(e as Error).message}\n`);
    }

    try {
      await seams.restartRuntime(latest);
    } catch (e) {
      ctx.printErr(`Warning: runtime restart failed: ${(e as Error).message}\n`);
    }

    ctx.print(
      `\n  ${StyleInfo.render("ℹ")} Run ${StyleBold.render("knowns sync")} to sync skills and rebuild the search index.\n`,
    );
  },
});
