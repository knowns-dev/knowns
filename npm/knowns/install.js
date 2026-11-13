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

async function main() {
  try {
    await ensurePlatformBinary();
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
  releaseAssetUrl,
  resolveBinaryFromPackageDir,
  resolveInstalledPackageDir,
  verifySha256,
  writeDownloadedPackageMetadata,
};
