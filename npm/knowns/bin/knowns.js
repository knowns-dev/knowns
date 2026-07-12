#!/usr/bin/env node

const { execFileSync } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const Module = require("module");

function uniq(values) {
  return [...new Set(values)];
}

function resolveFromPackageDir(pkgDir, ext) {
  for (const name of [`knowns${ext}`, "knowns"]) {
    const candidate = path.join(pkgDir, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function ensureExecutable(binary) {
  if (process.platform === "win32") {
    return;
  }

  const mode = fs.statSync(binary).mode;
  if ((mode & 0o111) !== 0) {
    return;
  }

  fs.chmodSync(binary, mode | 0o755);
}

function getInstallHint(pkgName) {
  return (
    `npm install knowns ${pkgName}\n` +
    `Or for global installs: npm install -g knowns ${pkgName}`
  );
}

function getWindowsRuntimeCacheRoot() {
  if (process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "Knowns", "npm-runtime");
  }
  return path.join(os.homedir(), ".knowns", "cache", "npm-runtime");
}

function stageWindowsBinary(binary, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") {
    return binary;
  }

  const arch = options.arch || process.arch;
  const sourceDir = path.dirname(binary);
  const packageJsonPath = path.join(sourceDir, "package.json");
  let version = "unknown";
  try {
    version = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).version || version;
  } catch {}

  const cacheRoot = options.cacheRoot || getWindowsRuntimeCacheRoot();
  const cacheDir = path.join(cacheRoot, `${version}-${arch}`);
  const cachedBinary = path.join(cacheDir, path.basename(binary));
  if (fs.existsSync(cachedBinary)) {
    return cachedBinary;
  }

  fs.mkdirSync(cacheRoot, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(cacheRoot, ".staging-"));
  try {
    fs.cpSync(sourceDir, stagingDir, { recursive: true, force: true });
    try {
      fs.renameSync(stagingDir, cacheDir);
    } catch (error) {
      if (!fs.existsSync(cachedBinary)) {
        throw error;
      }
    }
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  if (!fs.existsSync(cachedBinary)) {
    throw new Error(`Failed to stage Knowns Windows runtime at ${cachedBinary}`);
  }
  return cachedBinary;
}

function getBinaryPath() {
  const platform = os.platform();
  const arch = os.arch();

  const platformMap = {
    darwin: "darwin",
    linux: "linux",
    win32: "win",
  };

  const archMap = {
    arm64: "arm64",
    x64: "x64",
    ia32: "x64", // fallback
  };

  const p = platformMap[platform];
  const a = archMap[arch];

  if (!p || !a) {
    console.error(`Unsupported platform: ${platform}-${arch}`);
    process.exit(1);
  }

  const pkgName = `@knowns/${p}-${a}`;
  const ext = platform === "win32" ? ".exe" : "";
  const pkgParts = pkgName.split("/");

  const packageDirs = uniq([
    path.resolve(__dirname, "..", "node_modules", ...pkgParts),
    path.resolve(__dirname, "..", "..", ...pkgParts),
    path.resolve(__dirname, "..", "..", "node_modules", ...pkgParts),
    path.resolve(__dirname, "..", "..", "..", "node_modules", ...pkgParts),
    ...module.paths.map((base) => path.join(base, ...pkgParts)),
    ...Module.globalPaths.map((base) => path.join(base, ...pkgParts)),
  ]);

  for (const pkgDir of packageDirs) {
    const resolved = resolveFromPackageDir(pkgDir, ext);
    if (resolved) {
      return resolved;
    }
  }

  for (const base of uniq([__dirname, process.cwd(), ...module.paths, ...Module.globalPaths])) {
    try {
      const pkgJson = require.resolve(`${pkgName}/package.json`, { paths: [base] });
      const resolved = resolveFromPackageDir(path.dirname(pkgJson), ext);
      if (resolved) {
        return resolved;
      }
    } catch {}
  }

  try {
    const pkgJson = require.resolve(`${pkgName}/package.json`);
    const resolved = resolveFromPackageDir(path.dirname(pkgJson), ext);
    if (resolved) {
      return resolved;
    }
  } catch {}

  console.error(
    `Could not find knowns binary for ${platform}-${arch}.\n` +
      `Expected package: ${pkgName}\n` +
      `Try reinstalling:\n${getInstallHint(pkgName)}`
  );
  process.exit(1);
}

function main() {
  const binary = stageWindowsBinary(getBinaryPath());
  const args = process.argv.slice(2);

  try {
    ensureExecutable(binary);
    execFileSync(binary, args, {
      stdio: "inherit",
      env: process.env,
    });
  } catch (err) {
    if (err.status !== undefined) {
      process.exit(err.status);
    }
    throw err;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  getBinaryPath,
  getWindowsRuntimeCacheRoot,
  stageWindowsBinary,
};
