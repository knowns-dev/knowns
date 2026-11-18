// Packages the Bun-compiled binaries in cli/dist into release artifacts:
//   <out>/npm/<pkg>/            publishable npm packages (platform packages + the knowns wrapper)
//   <out>/assets/               knowns-<platform>.tar.gz + .sha256 (install.sh / install.ps1 / Homebrew)
//
// Bun dist directories are named windows-*, the npm packages and release assets win-*.
// Asset and package names are identical to the 0.34.x Go releases, so old versions keep working.
//
// Usage: bun scripts/package-release.ts --version 1.0.0 [--dist cli/dist] [--out DIR] [--only a,b]
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export interface PlatformMap {
  /** Directory name under cli/dist (Bun target without the "bun-" prefix). */
  dist: string;
  /** Platform suffix shared by the npm package (@knowns/<npm>), the npm dir and the release asset. */
  npm: string;
  exe: string;
  /** The Go launcher built by cli/scripts/proxy.ts (spec mcp-thin-proxy D10), under its build name. */
  launcher: string;
  /** The engine's installed name, next to the launcher (`knowns-engine[.exe]`). */
  engine: string;
}

export const PLATFORMS: readonly PlatformMap[] = [
  { dist: "darwin-arm64", npm: "darwin-arm64", exe: "knowns", launcher: "knowns.launcher", engine: "knowns-engine" },
  { dist: "darwin-x64", npm: "darwin-x64", exe: "knowns", launcher: "knowns.launcher", engine: "knowns-engine" },
  { dist: "linux-arm64", npm: "linux-arm64", exe: "knowns", launcher: "knowns.launcher", engine: "knowns-engine" },
  { dist: "linux-x64", npm: "linux-x64", exe: "knowns", launcher: "knowns.launcher", engine: "knowns-engine" },
  { dist: "windows-arm64", npm: "win-arm64", exe: "knowns.exe", launcher: "knowns.launcher.exe", engine: "knowns-engine.exe" },
  { dist: "windows-x64", npm: "win-x64", exe: "knowns.exe", launcher: "knowns.launcher.exe", engine: "knowns-engine.exe" },
];

/**
 * A second name for knowns.exe in the Windows archives, so a 0.34.x Go `knowns update` installs a
 * runnable binary. Go 0.34.1 extracts next to the downloaded `knowns-win-<arch>.tar.gz`, walks that
 * directory in sorted order and takes the first file named knowns.exe or starting with `knowns-`.
 * `knowns-win-<arch>.tar.gz` sorts before `knowns.exe` ('-' < '.'), so without this entry Go
 * installs the gzip archive itself and prints "Upgrade complete." (KN-6M228C). This name starts
 * with `knowns-` and sorts before `knowns-win-`, so Go takes it first. It is a tar hard link, so
 * the archive grows by one header. install.ps1 and TS `knowns update` still pick knowns.exe.
 */
export const GO_UPDATE_ENTRY = "knowns-0.34-update.exe";

/**
 * Release archive members (spec mcp-thin-proxy D10). The rule: every file an older updater could
 * pick is the full engine, so an old install ends working whichever one it takes.
 *   knowns[.exe]            the engine, the only file with the exact name 0.34.x, 0.35.0 and the install
 *                           scripts look for
 *   knowns-engine[.exe]     hard link to it: the name the engine has once the install is split, and a
 *                           `knowns-*` candidate for the updaters that accept that prefix
 *   knowns-0.34-update.exe  (Windows) hard link, see GO_UPDATE_ENTRY
 *   knowns.launcher[.exe]   the Go launcher. Its name neither equals `knowns` nor starts with
 *                           `knowns-`, so no old matcher can pick it
 *   layout.json             which member is installed under which name
 */
export const LAYOUT_FILE = "layout.json";

export function archiveEntries(p: PlatformMap): string[] {
  const win = p.npm.startsWith("win-");
  return [
    `./${p.exe}`,
    `./${p.engine}`,
    ...(win ? [`./${GO_UPDATE_ENTRY}`] : []),
    `./${p.launcher}`,
    `./${LAYOUT_FILE}`,
  ];
}

/** What the new installers read: install `launcher` as `knowns` and `engine` as `knowns-engine`. */
export function layoutJson(p: PlatformMap, version: string): string {
  return `${JSON.stringify(
    {
      layout: 1,
      version,
      launcher: { file: p.launcher, installAs: p.exe },
      engine: { file: p.exe, installAs: p.engine },
    },
    null,
    2,
  )}\n`;
}

export interface PackageOptions {
  version: string;
  distDir: string;
  outDir: string;
  npmDir: string;
  installDir?: string;
  only?: string[];
}

export interface PackageResult {
  packages: string[];
  assets: string[];
}

export function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function packageRelease(opts: PackageOptions): PackageResult {
  const version = opts.version.replace(/^v/, "");
  const platforms = PLATFORMS.filter((p) => !opts.only || opts.only.includes(p.npm));
  const npmOut = join(opts.outDir, "npm");
  const assetsOut = join(opts.outDir, "assets");
  mkdirSync(npmOut, { recursive: true });
  mkdirSync(assetsOut, { recursive: true });
  const result: PackageResult = { packages: [], assets: [] };

  for (const p of platforms) {
    const bin = join(opts.distDir, p.dist, p.exe);
    if (!existsSync(bin)) throw new Error(`missing binary for ${p.npm}: ${bin}`);
    const launcherBin = join(opts.distDir, p.dist, p.launcher);
    if (!existsSync(launcherBin)) {
      throw new Error(`missing launcher for ${p.npm}: ${launcherBin}`);
    }

    const pkgDir = join(npmOut, `knowns-${p.npm}`);
    rmSync(pkgDir, { recursive: true, force: true });
    mkdirSync(pkgDir, { recursive: true });
    const pkg = JSON.parse(
      readFileSync(join(opts.npmDir, `knowns-${p.npm}`, "package.json"), "utf8"),
    );
    pkg.version = version;
    pkg.main = p.exe;
    // The npm package holds the installed names: the launcher is the `knowns` bin, the engine sits beside it.
    pkg.files = [p.exe, p.engine];
    writeFileSync(join(pkgDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    cpSync(launcherBin, join(pkgDir, p.exe));
    chmodSync(join(pkgDir, p.exe), 0o755);
    cpSync(bin, join(pkgDir, p.engine));
    chmodSync(join(pkgDir, p.engine), 0o755);
    result.packages.push(pkgDir);

    // Release asset: the binary at the archive root as ./knowns[.exe], plus on Windows the
    // GO_UPDATE_ENTRY hard link to it. Staged apart from the npm package, whose files list is exact.
    const asset = join(assetsOut, `knowns-${p.npm}.tar.gz`);
    const stage = join(opts.outDir, "stage", p.npm);
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    cpSync(bin, join(stage, p.exe));
    chmodSync(join(stage, p.exe), 0o755);
    cpSync(launcherBin, join(stage, p.launcher));
    chmodSync(join(stage, p.launcher), 0o755);
    writeFileSync(join(stage, LAYOUT_FILE), layoutJson(p, version));
    const entries = archiveEntries(p);
    linkSync(join(stage, p.exe), join(stage, p.engine));
    if (p.npm.startsWith("win-")) linkSync(join(stage, p.exe), join(stage, GO_UPDATE_ENTRY));
    // COPYFILE_DISABLE: macOS bsdtar otherwise adds a ._<name> AppleDouble entry for any file with
    // xattrs (com.apple.provenance on locally built binaries), which extracts as junk elsewhere.
    const tar = Bun.spawnSync(["tar", "-czf", asset, "-C", stage, ...entries], {
      stderr: "pipe",
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    rmSync(stage, { recursive: true, force: true });
    if (tar.exitCode !== 0) throw new Error(`tar failed for ${p.npm}: ${tar.stderr.toString()}`);
    writeFileSync(`${asset}.sha256`, `${sha256File(asset)}  knowns-${p.npm}.tar.gz\n`);
    result.assets.push(asset);
  }
  rmSync(join(opts.outDir, "stage"), { recursive: true, force: true });

  // The wrapper: same files as npm/knowns minus tests, pinned to this version.
  const wrapperOut = join(npmOut, "knowns");
  rmSync(wrapperOut, { recursive: true, force: true });
  cpSync(join(opts.npmDir, "knowns"), wrapperOut, {
    recursive: true,
    filter: (src) => !/\.test\.js$/.test(src) && !src.includes("node_modules"),
  });
  const wrapper = JSON.parse(readFileSync(join(wrapperOut, "package.json"), "utf8"));
  wrapper.version = version;
  wrapper.optionalDependencies = Object.fromEntries(
    PLATFORMS.map((p) => [`@knowns/${p.npm}`, version]),
  );
  writeFileSync(join(wrapperOut, "package.json"), `${JSON.stringify(wrapper, null, 2)}\n`);
  result.packages.push(wrapperOut);

  if (opts.installDir) {
    for (const f of ["install.sh", "install.ps1", "uninstall.sh", "uninstall.ps1"]) {
      cpSync(join(opts.installDir, f), join(assetsOut, f));
    }
  }
  return result;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const version = arg("version") ?? process.env.KNOWNS_VERSION;
  if (!version) {
    console.error(
      "usage: package-release.ts --version X.Y.Z [--dist DIR] [--out DIR] [--only a,b]",
    );
    process.exit(2);
  }
  const res = packageRelease({
    version,
    distDir: resolve(arg("dist") ?? join(root, "cli", "dist")),
    outDir: resolve(arg("out") ?? join(root, "release")),
    npmDir: join(root, "npm"),
    installDir: join(root, "install"),
    only: arg("only")?.split(","),
  });
  for (const p of res.packages) console.log(`package ${p}`);
  for (const a of res.assets) console.log(`asset   ${a}`);
}
