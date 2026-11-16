#!/usr/bin/env node

"use strict";

const crypto = require("crypto");
const { spawnSync } = require("child_process");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

function resolveBinaryFromPackageDir(pkgDir, ext) {
  for (const name of [`knowns${ext}`, "knowns"]) {
    const candidate = path.join(pkgDir, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function getPlatformPackage(platform = os.platform(), arch = os.arch()) {
  const platformMap = {
    darwin: "darwin",
    linux: "linux",
    win32: "win",
  };

  const archMap = {
    arm64: "arm64",
    x64: "x64",
    ia32: "x64",
  };

  const p = platformMap[platform];
  const a = archMap[arch];

  if (!p || !a) {
    return null;
  }

  return {
    name: `@knowns/${p}-${a}`,
    asset: `knowns-${p}-${a}`,
    ext: platform === "win32" ? ".exe" : "",
    packageOs: platform,
    packageCpu: arch === "ia32" ? "x64" : arch,
  };
}

function getPackageRoot() {
  return __dirname;
}

function getPackageJson(packageRoot) {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
}

function getRequestedVersion(packageRoot, pkgName) {
  const pkg = getPackageJson(packageRoot);
  return pkg.optionalDependencies && pkg.optionalDependencies[pkgName];
}

function resolveInstalledPackageDir(packageRoot, pkgName, ext) {
  const pkgParts = pkgName.split("/");
  const direct = path.join(packageRoot, "node_modules", ...pkgParts);
  if (resolveBinaryFromPackageDir(direct, ext)) {
    return direct;
  }

  try {
    const pkgJson = require.resolve(`${pkgName}/package.json`, { paths: [packageRoot] });
    const pkgDir = path.dirname(pkgJson);
    if (resolveBinaryFromPackageDir(pkgDir, ext)) {
      return pkgDir;
    }
  } catch {}

  return null;
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function moveOrCopyDir(src, dest) {
  removeDir(dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  try {
    fs.renameSync(src, dest);
    return;
  } catch {}

  fs.cpSync(src, dest, { recursive: true, force: true });
}

function getNpmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function installPackageIntoPackageRoot(packageRoot, pkgName, version) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "knowns-install-"));
  const env = { ...process.env };
  delete env.npm_config_global;
  delete env.npm_config_prefix;

  try {
    fs.writeFileSync(path.join(tmpRoot, "package.json"), "{}\n");

    const result = spawnSync(
      getNpmCommand(),
      ["install", "--loglevel=error", "--prefer-offline", "--no-audit", "--progress=false", "--no-save", `${pkgName}@${version}`],
      {
        cwd: tmpRoot,
        stdio: "pipe",
        encoding: "utf8",
        env,
      }
    );

    if ((result.status ?? 1) !== 0) {
      throw new Error((result.stderr || result.stdout || `Failed to install ${pkgName}`).trim());
    }

    const src = path.join(tmpRoot, "node_modules", ...pkgName.split("/"));
    if (!fs.existsSync(src)) {
      throw new Error(`Installed package is missing: ${pkgName}`);
    }

    const dest = path.join(packageRoot, "node_modules", ...pkgName.split("/"));
    moveOrCopyDir(src, dest);
  } finally {
    removeDir(tmpRoot);
  }
}

function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        const status = response.statusCode || 0;

        if (status >= 300 && status < 400 && response.headers.location) {
          if (redirects >= 5) {
            response.resume();
            reject(new Error(`Too many redirects while downloading ${url}`));
            return;
          }

          const nextUrl = new URL(response.headers.location, url).toString();
          response.resume();
          fetchBuffer(nextUrl, redirects + 1).then(resolve, reject);
          return;
        }

        if (status < 200 || status >= 300) {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8").trim();
            reject(new Error(`Download failed (${status}) for ${url}${body ? `: ${body}` : ""}`));
          });
          return;
        }

        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

function parseSha256(text) {
  const match = text.trim().match(/^([a-f0-9]{64})\b/i);
  if (!match) {
    throw new Error("Invalid sha256 file contents");
  }
  return match[1].toLowerCase();
}

function verifySha256(buffer, expected) {
  const actual = crypto.createHash("sha256").update(buffer).digest("hex");
  if (actual !== expected) {
    throw new Error(`Checksum mismatch: expected ${expected}, got ${actual}`);
  }
}

function extractTarToDir(buffer, dest) {
  let offset = 0;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    offset += 512;

    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeText = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const type = header.subarray(156, 157).toString("utf8") || "0";

    if (!rawName && !sizeText) {
      break;
    }

    const size = sizeText ? parseInt(sizeText, 8) : 0;
    if (!Number.isFinite(size)) {
      throw new Error(`Invalid tar entry size for ${rawName || "<unknown>"}`);
    }

    const normalizedName = rawName.replace(/^package\//, "").replace(/\/$/, "");
    const filePath = normalizedName ? path.join(dest, normalizedName) : dest;

    if (type === "5") {
      fs.mkdirSync(filePath, { recursive: true });
    } else if (type === "0" || type === "\0") {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, buffer.subarray(offset, offset + size));
    }

    offset += Math.ceil(size / 512) * 512;
  }
}

function writeDownloadedPackageMetadata(dest, platformPackage, version) {
  fs.writeFileSync(
    path.join(dest, "package.json"),
    JSON.stringify(
      {
        name: platformPackage.name,
        version,
        description: `Knowns binary for ${platformPackage.asset.replace(/^knowns-/, "").replace(/-/g, " ")}`,
        os: [platformPackage.packageOs],
        cpu: [platformPackage.packageCpu],
        main: `knowns${platformPackage.ext}`,
        license: "MIT",
        homepage: "https://knowns.sh",
        repository: {
          type: "git",
          url: "git+https://github.com/knowns-dev/knowns.git",
        },
      },
      null,
      2
    ) + "\n"
  );
}

// Asset names (knowns-<os>-<arch>.tar.gz) and the tag scheme (v<version>) are the same for the
// Go releases (0.34.x) and the TypeScript releases (1.x), so one function serves both.
function releaseAssetUrl(platformPackage, version) {
  return `https://github.com/knowns-dev/knowns/releases/download/v${version}/${platformPackage.asset}.tar.gz`;
}

async function downloadPackageFromGitHubRelease(packageRoot, platformPackage, version) {
  const baseUrl = releaseAssetUrl(platformPackage, version);
  const checksumUrl = `${baseUrl}.sha256`;

  const [archive, checksumFile] = await Promise.all([fetchBuffer(baseUrl), fetchBuffer(checksumUrl)]);
  const expectedSha = parseSha256(checksumFile.toString("utf8"));
  verifySha256(archive, expectedSha);

  const dest = path.join(packageRoot, "node_modules", ...platformPackage.name.split("/"));
  removeDir(dest);
  fs.mkdirSync(dest, { recursive: true });

  const extracted = zlib.gunzipSync(archive);
  extractTarToDir(extracted, dest);
  writeDownloadedPackageMetadata(dest, platformPackage, version);
}

function getInstallHint(pkgName) {
  const base = process.env.npm_config_global === "true" ? "npm install -g" : "npm install";
  return `${base} knowns ${pkgName}`;
}

async function ensurePlatformBinary() {
  const platformPackage = getPlatformPackage();
  if (!platformPackage) {
    return;
  }

  const packageRoot = getPackageRoot();
  const version = getRequestedVersion(packageRoot, platformPackage.name);
  if (!version || version === "0.0.0") {
    return;
  }

  if (resolveInstalledPackageDir(packageRoot, platformPackage.name, platformPackage.ext)) {
    return;
  }

  let npmError = null;
  try {
    installPackageIntoPackageRoot(packageRoot, platformPackage.name, version);
  } catch (error) {
    npmError = error;
  }

  if (!resolveInstalledPackageDir(packageRoot, platformPackage.name, platformPackage.ext)) {
    let githubError = null;
    try {
      await downloadPackageFromGitHubRelease(packageRoot, platformPackage, version);
    } catch (error) {
      githubError = error;
    }

    if (!resolveInstalledPackageDir(packageRoot, platformPackage.name, platformPackage.ext)) {
      const messages = [];
      if (npmError) {
        messages.push(`npm install fallback failed: ${npmError.message}`);
      }
      if (githubError) {
        messages.push(`GitHub release fallback failed: ${githubError.message}`);
      }
      throw new Error(messages.join("\n") || `Could not install ${platformPackage.name}`);
    }
  }
}

// --- direct launch --------------------------------------------------------------------------
//
// bin/knowns.js is a Node shim that execFileSync's the native binary and waits, so every npm
// installed `knowns mcp --stdio` costs a node process (about 65 MB working set on Windows) next to
// knowns itself. After the platform binary is in place the postinstall makes the command start the
// binary directly. The Node shim stays as the fallback: --ignore-scripts, a missing platform
// package, or any failure below leaves it exactly as shipped.

/** True when file starts with a "#!" line, i.e. it is still the Node shim. */
function isShim(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    return head[0] === 0x23 && head[1] === 0x21;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function nativeBinaryRuns(binary) {
  const r = spawnSync(binary, ["--version"], {
    stdio: "ignore",
    timeout: 30000,
    env: { ...process.env, NO_UPDATE_CHECK: "1" },
  });
  return r.status === 0;
}

/**
 * macOS and Linux (what esbuild does): put the native binary where bin/knowns.js is, so npm's bin
 * symlinks, which point at that path, launch it with no Node in between. Hard link when possible
 * (no second copy on disk), renamed into place so a running process never sees a half-written
 * file and macOS never re-validates a rewritten inode. Returns true when the command now starts
 * the native binary.
 */
function useNativeBinaryDirectly(packageRoot, platformPackage, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "win32") {
    return false;
  }
  const pkgDir = resolveInstalledPackageDir(packageRoot, platformPackage.name, platformPackage.ext);
  const source = pkgDir && resolveBinaryFromPackageDir(pkgDir, platformPackage.ext);
  if (!source) {
    return false;
  }
  const done = linkNativeInto(path.join(packageRoot, "bin", "knowns.js"), source);
  // The proxy command gets the same treatment when the platform package ships one.
  const proxySource = path.join(pkgDir, `knowns-proxy${platformPackage.ext}`);
  if (fs.existsSync(proxySource)) {
    linkNativeInto(path.join(packageRoot, "bin", "knowns-proxy.js"), proxySource);
  }
  return done;
}

function linkNativeInto(dest, source) {
  if (!fs.existsSync(dest) || !isShim(dest)) {
    return false;
  }

  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    fs.rmSync(tmp, { force: true });
    try {
      fs.linkSync(source, tmp);
    } catch {
      fs.copyFileSync(source, tmp);
    }
    fs.chmodSync(tmp, 0o755);
    if (!nativeBinaryRuns(tmp)) {
      fs.rmSync(tmp, { force: true });
      return false;
    }
    fs.renameSync(tmp, dest);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    return false;
  }
}

/** Remove leftovers of an interrupted bin swap: bin/knowns.js.<pid>.tmp. Returns how many were removed. */
function sweepStrayTmp(packageRoot) {
  let n = 0;
  const dir = path.join(packageRoot, "bin");
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {}
  for (const name of names) {
    if (/^knowns\.js\.\d+\.tmp$/.test(name)) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
        n++;
      } catch {}
    }
  }
  return n;
}

/**
 * Each staged runtime is about 125 MB and nothing ever removed the old ones. Keep the version in
 * use (keepDir) and delete the rest of the npm-runtime cache. A version still running on Windows
 * cannot be deleted and simply stays; a shim whose staged exe was pruned falls back to the Node
 * shim, which stages it again. Returns the removed directory names.
 */
function pruneNpmRuntimes(cacheRoot, keepDir) {
  const removed = [];
  if (path.basename(cacheRoot).toLowerCase() !== "npm-runtime") return removed;
  let names = [];
  try {
    names = fs.readdirSync(cacheRoot);
  } catch {
    return removed;
  }
  for (const name of names) {
    const full = path.join(cacheRoot, name);
    if (path.resolve(full) === path.resolve(keepDir)) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
      if (!fs.existsSync(full)) removed.push(name);
    } catch {}
  }
  return removed;
}

const WINDOWS_SHIM_NAMES = ["knowns", "kn"];

// The exact text npm (cmd-shim 7) writes for a bin that runs a Node script. Only a file that is
// this text, with the script path and nothing else varying, is ours to rewrite: a user's own
// wrapper that happens to mention knowns\bin\knowns.js is left alone. pnpm and yarn write the same
// shapes (pnpm adds NODE_PATH lines, which are ignored when comparing).
const SHIM_JS = "@@JS@@";
const NPM_SHIM_TEMPLATES = {
  ".cmd": [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${SHIM_JS}" %*`,
  ],
  ".ps1": [
    "#!/usr/bin/env pwsh",
    "$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent",
    "",
    '$exe=""',
    'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {',
    "  # Fix case when both the Windows and Linux builds of Node",
    "  # are installed in the same directory",
    '  $exe=".exe"',
    "}",
    "$ret=0",
    'if (Test-Path "$basedir/node$exe") {',
    "  # Support pipeline input",
    "  if ($MyInvocation.ExpectingInput) {",
    `    $input | & "$basedir/node$exe"  "$basedir/${SHIM_JS}" $args`,
    "  } else {",
    `    & "$basedir/node$exe"  "$basedir/${SHIM_JS}" $args`,
    "  }",
    "  $ret=$LASTEXITCODE",
    "} else {",
    "  # Support pipeline input",
    "  if ($MyInvocation.ExpectingInput) {",
    `    $input | & "node$exe"  "$basedir/${SHIM_JS}" $args`,
    "  } else {",
    `    & "node$exe"  "$basedir/${SHIM_JS}" $args`,
    "  }",
    "  $ret=$LASTEXITCODE",
    "}",
    "exit $ret",
  ],
  "": [
    "#!/bin/sh",
    String.raw`basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")`,
    "",
    "case `uname` in",
    "    *CYGWIN*|*MINGW*|*MSYS*)",
    "        if command -v cygpath > /dev/null 2>&1; then",
    '            basedir=`cygpath -w "$basedir"`',
    "        fi",
    "    ;;",
    "esac",
    "",
    'if [ -x "$basedir/node" ]; then',
    `  exec "$basedir/node"  "$basedir/${SHIM_JS}" "$@"`,
    "else ",
    `  exec node  "$basedir/${SHIM_JS}" "$@"`,
    "fi",
  ],
};

const SHIM_TARGET = /^(?:node_modules[\\/]knowns|\.\.[\\/]knowns)[\\/]bin[\\/]knowns\.js$/;

/** Where knowns.js is (relative to the shim, with /) when file is exactly npm's shim for knowns, else null. */
function npmShimTarget(file, ext) {
  let text;
  try {
    if (fs.statSync(file).size > 4096) return null;
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\n$/, "")
    .split("\n")
    .filter((l) => !/NODE_PATH/.test(l));
  const template = NPM_SHIM_TEMPLATES[ext];
  if (!template || lines.length !== template.length) return null;
  let target = null;
  for (let i = 0; i < template.length; i++) {
    if (!template[i].includes(SHIM_JS)) {
      if (lines[i] !== template[i]) return null;
      continue;
    }
    const [before, after] = template[i].split(SHIM_JS);
    if (!lines[i].startsWith(before) || !lines[i].endsWith(after)) return null;
    const middle = lines[i].slice(before.length, lines[i].length - after.length);
    if (!SHIM_TARGET.test(middle)) return null;
    if (target !== null && target !== middle) return null;
    target = middle;
  }
  return target === null ? null : target.replace(/\\/g, "/");
}

/** exe relative to LOCALAPPDATA (with backslashes) when it lives there, else null. */
function underLocalAppData(exe, localAppData) {
  if (!localAppData) return null;
  const norm = (p) => p.replace(/\//g, "\\").replace(/\\+$/, "");
  const base = norm(localAppData);
  const full = norm(exe);
  if (
    full.length > base.length &&
    full.slice(0, base.length).toLowerCase() === base.toLowerCase() &&
    full[base.length] === "\\"
  ) {
    return full.slice(base.length + 1);
  }
  return null;
}

/**
 * What a rewritten shim says. The staged exe is written as %LOCALAPPDATA%\... (and the PowerShell
 * and sh equivalents) when it lives there, so the file stays pure ASCII even for a profile such
 * as C:\Users\Nguyễn: cmd reads a .cmd in the OEM code page and Windows PowerShell 5.1 reads a
 * BOM-less .ps1 as ANSI. Every shim falls back to the Node shim (fallbackRel is where
 * bin/knowns.js is, relative to the shim) when the staged exe is gone: Storage Sense, antivirus or
 * a cleanup may delete it, and the Node shim stages it again.
 */
function windowsShimContents(ext, exe, options = {}) {
  const localAppData =
    options.localAppData !== undefined ? options.localAppData : process.env.LOCALAPPDATA;
  const rel = underLocalAppData(exe, localAppData);
  const fallback = options.fallbackRel || null;
  if (ext === ".cmd") {
    const exeRef = rel !== null ? `%LOCALAPPDATA%\\${rel}` : exe;
    const lines = ["@ECHO off", "SETLOCAL", `SET "KN_EXE=${exeRef}"`];
    // No parenthesised blocks: a ")" in an argument would end one early.
    if (fallback) {
      lines.push(
        'IF NOT EXIST "%KN_EXE%" GOTO kn_fallback',
        '"%KN_EXE%" %*',
        "EXIT /B %ERRORLEVEL%",
        ":kn_fallback",
        `node "%~dp0${fallback.replace(/\//g, "\\")}" %*`,
      );
    } else {
      lines.push('"%KN_EXE%" %*');
    }
    lines.push("EXIT /B %ERRORLEVEL%");
    return `${lines.join("\r\n")}\r\n`;
  }
  if (ext === ".ps1") {
    const q = (v) => `'${v.replace(/'/g, "''")}'`;
    const exeExpr = rel !== null ? `(Join-Path $env:LOCALAPPDATA ${q(rel)})` : q(exe);
    const lines = ["#!/usr/bin/env pwsh", `$kn_exe = ${exeExpr}`];
    if (fallback) {
      lines.push(
        "if (Test-Path -LiteralPath $kn_exe) {",
        "  & $kn_exe $args",
        "} else {",
        `  & node (Join-Path $PSScriptRoot ${q(fallback)}) $args`,
        "}",
      );
    } else {
      lines.push("& $kn_exe $args");
    }
    lines.push("exit $LASTEXITCODE");
    return `${lines.join("\n")}\n`;
  }
  // The extensionless file is for Git Bash and similar: mixed C:/ paths work there.
  const exeRef =
    rel !== null ? `"$LOCALAPPDATA/${rel.replace(/\\/g, "/")}"` : `"${exe.replace(/\\/g, "/")}"`;
  const lines = ["#!/bin/sh", `kn_exe=${exeRef}`, 'if [ -f "$kn_exe" ]; then', '  exec "$kn_exe" "$@"', "fi"];
  if (fallback) {
    lines.push(
      String.raw`basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")`,
      `exec node "$basedir/${fallback}" "$@"`,
    );
  } else {
    lines.push('echo "knowns: $kn_exe is missing" >&2', "exit 127");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Windows cannot replace a process image, and npm writes knowns.cmd / knowns.ps1 to run
 * `node bin/knowns.js`. npm has already written them when postinstall runs, so rewrite them to
 * start the binary directly. They point at the staged copy under %LOCALAPPDATA% (the same copy the
 * Node shim stages), never at node_modules, because a running knowns.exe there would lock the file
 * and make `npm i -g knowns@new` fail with EBUSY. Only npm's own shim text is rewritten, and only
 * in a real bin directory: this package's node_modules/.bin, or the global prefix. Returns how
 * many shim files were rewritten.
 */
function useNativeBinaryOnWindows(packageRoot, platformPackage, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") {
    return 0;
  }
  const pkgDir = resolveInstalledPackageDir(packageRoot, platformPackage.name, platformPackage.ext);
  const source = pkgDir && resolveBinaryFromPackageDir(pkgDir, platformPackage.ext);
  if (!source) {
    return 0;
  }

  const dirs = [];
  const modulesDir = path.resolve(packageRoot, "..");
  if (path.basename(modulesDir).toLowerCase() === "node_modules") {
    dirs.push(path.join(modulesDir, ".bin"));
  }
  const env = options.env || process.env;
  if (env.npm_config_global === "true" && env.npm_config_prefix) {
    dirs.push(env.npm_config_prefix);
  }
  const targets = [];
  for (const dir of new Set(dirs.map((d) => path.resolve(d)))) {
    for (const name of WINDOWS_SHIM_NAMES) {
      for (const ext of ["", ".cmd", ".ps1"]) {
        const file = path.join(dir, name + ext);
        if (fs.existsSync(file) && npmShimTarget(file, ext) !== null) {
          targets.push({ file, ext, dir });
        }
      }
    }
  }
  if (targets.length === 0) {
    return 0;
  }

  // Only now stage the 100 MB runtime: nothing to point at without a shim to rewrite.
  const stage = options.stage || require("./bin/knowns.js").stageWindowsBinary;
  const exe = stage(source, options.stageOptions);
  if (!(options.verify || nativeBinaryRuns)(exe)) {
    return 0;
  }
  let rewritten = 0;
  for (const { file, ext, dir } of targets) {
    try {
      const fallbackRel = path
        .relative(dir, path.join(packageRoot, "bin", "knowns.js"))
        .replace(/\\/g, "/");
      fs.writeFileSync(
        file,
        windowsShimContents(ext, exe, { fallbackRel, localAppData: options.localAppData }),
      );
      rewritten++;
    } catch {}
  }
  if (rewritten > 0) {
    pruneNpmRuntimes(path.dirname(path.dirname(exe)), path.dirname(exe));
  }
  return rewritten;
}

function enableDirectLaunch(packageRoot, platformPackage) {
  try {
    sweepStrayTmp(packageRoot);
    useNativeBinaryDirectly(packageRoot, platformPackage);
    useNativeBinaryOnWindows(packageRoot, platformPackage);
  } catch {
    // The Node shim keeps working; never fail an install over an optimisation.
  }
}

async function main() {
  try {
    await ensurePlatformBinary();
    const platformPackage = getPlatformPackage();
    const version = platformPackage && getRequestedVersion(getPackageRoot(), platformPackage.name);
    if (platformPackage && version && version !== "0.0.0") {
      enableDirectLaunch(getPackageRoot(), platformPackage);
    }
  } catch (error) {
    const platformPackage = getPlatformPackage();
    const details = error && error.message ? error.message : String(error);
    console.error(`Failed to install Knowns platform binary.${platformPackage ? ` Expected package: ${platformPackage.name}.` : ""}`);
    console.error(details);
    if (platformPackage) {
      console.error(`Try: ${getInstallHint(platformPackage.name)}`);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  downloadPackageFromGitHubRelease,
  ensurePlatformBinary,
  extractTarToDir,
  fetchBuffer,
  getInstallHint,
  getPlatformPackage,
  getRequestedVersion,
  installPackageIntoPackageRoot,
  parseSha256,
  pruneNpmRuntimes,
  releaseAssetUrl,
  resolveBinaryFromPackageDir,
  resolveInstalledPackageDir,
  sweepStrayTmp,
  useNativeBinaryDirectly,
  useNativeBinaryOnWindows,
  verifySha256,
  windowsShimContents,
  writeDownloadedPackageMetadata,
};
