// AC1/AC2/AC5 of TSR-Z7CRS1: packaging maps Bun dist names to npm package names for all six
// platforms, release asset names match the Go releases, and the version comes from the tag.
import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  GO_UPDATE_ENTRY,
  PLATFORMS,
  packageRelease,
  sha256File,
} from "../../../scripts/package-release.ts";
import { resolveVersion, UNTAGGED_VERSION } from "../../scripts/version.ts";
import { run, tempDir } from "./install-harness.ts";

const root = resolve(import.meta.dir, "../../..");
const { releaseAssetUrl, getPlatformPackage } = require(join(root, "npm/knowns/install.js"));

function fakeDist(): string {
  const dist = tempDir("dist");
  for (const p of PLATFORMS) {
    mkdirSync(join(dist, p.dist), { recursive: true });
    writeFileSync(join(dist, p.dist, p.exe), `binary:${p.dist}`);
  }
  return dist;
}

describe("package-release", () => {
  const out = tempDir("out");
  const res = packageRelease({
    version: "v1.0.0",
    distDir: fakeDist(),
    outDir: out,
    npmDir: join(root, "npm"),
    installDir: join(root, "install"),
  });

  test("covers all 6 platforms with Go-compatible asset names (windows -> win)", () => {
    const names = res.assets.map((a) => basename(a)).sort();
    expect(names).toEqual([
      "knowns-darwin-arm64.tar.gz",
      "knowns-darwin-x64.tar.gz",
      "knowns-linux-arm64.tar.gz",
      "knowns-linux-x64.tar.gz",
      "knowns-win-arm64.tar.gz",
      "knowns-win-x64.tar.gz",
    ]);
  });

  test("archives hold ./knowns or ./knowns.exe at the root and checksums verify", () => {
    for (const p of PLATFORMS) {
      const archive = join(out, "assets", `knowns-${p.npm}.tar.gz`);
      // Windows tar.exe ends listing lines with \r\n.
      const listing = run(["tar", "-tzf", archive]).stdout.trim().split(/\r?\n/);
      expect(listing).toEqual(
        p.npm.startsWith("win-") ? [`./${p.exe}`, `./${GO_UPDATE_ENTRY}`] : [`./${p.exe}`],
      );
      const sum = readFileSync(`${archive}.sha256`, "utf8");
      expect(sum).toBe(`${sha256File(archive)}  knowns-${p.npm}.tar.gz\n`);
    }
    expect(existsSync(join(out, "stage"))).toBe(false);
  });

  test("the Windows update entry is a hard link to knowns.exe, not a second copy", () => {
    for (const p of PLATFORMS.filter((x) => x.npm.startsWith("win-"))) {
      const archive = join(out, "assets", `knowns-${p.npm}.tar.gz`);
      const verbose = run(["tar", "-tvzf", archive]).stdout;
      expect(verbose).toMatch(
        new RegExp(
          `^h.*\\./${GO_UPDATE_ENTRY.replace(/\./g, "\\.")} link to \\./knowns\\.exe$`,
          "m",
        ),
      );
      const dir = tempDir("x");
      run(["tar", "-xzf", archive, "-C", dir]);
      expect(readFileSync(join(dir, GO_UPDATE_ENTRY), "utf8")).toBe(`binary:${p.dist}`);
      expect(readFileSync(join(dir, "knowns.exe"), "utf8")).toBe(`binary:${p.dist}`);
    }
  });
});

/**
 * The binary Go 0.34.1 `knowns update` installs from an archive: internal/cli/update.go
 * downloadAndReplaceBinary extracts into the directory that holds the downloaded archive, then
 * findFile walks it with filepath.Walk (names in byte order, depth first) and takes the first
 * regular file named knowns[.exe] or starting with `knowns-`.
 */
function goUpdatePick(archive: string, goos: "windows" | "darwin" | "linux"): string {
  const dir = tempDir("go-update");
  const downloaded = join(dir, basename(archive));
  copyFileSync(archive, downloaded);
  run(["tar", "-xzf", downloaded, "-C", dir]);
  const binaryName = goos === "windows" ? "knowns.exe" : "knowns";
  const walk = (d: string): string | undefined => {
    for (const name of readdirSync(d).sort((a, b) =>
      Buffer.compare(Buffer.from(a), Buffer.from(b)),
    )) {
      const full = join(d, name);
      const st = statSync(full);
      const lower = name.toLowerCase();
      if (!st.isDirectory() && (lower === binaryName || lower.startsWith("knowns-"))) return full;
      if (st.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      }
    }
    return undefined;
  };
  const found = walk(dir);
  if (!found) throw new Error("updated binary not found in release artifact");
  return readFileSync(found, "utf8");
}

describe.skipIf(process.platform !== "darwin")("package-release on macOS", () => {
  test("a binary with xattrs adds no ._ AppleDouble entry to the archive", () => {
    const dist = fakeDist();
    const p = PLATFORMS.find((x) => x.npm === "win-x64");
    if (!p) throw new Error("win-x64 missing");
    run(["xattr", "-w", "com.knowns.test", "1", join(dist, p.dist, p.exe)]);
    const out = tempDir("out-xattr");
    packageRelease({
      version: "1.0.0",
      distDir: dist,
      outDir: out,
      npmDir: join(root, "npm"),
      only: [p.npm],
    });
    // bsdtar on macOS folds ._ entries back into xattrs when listing, so read the raw tar stream.
    const raw = Bun.gunzipSync(readFileSync(join(out, "assets", `knowns-${p.npm}.tar.gz`)));
    expect(Buffer.from(raw).includes("._")).toBe(false);
  });
});

describe("KN-6M228C: a Go 0.34.1 `knowns update` installs the binary, not the archive", () => {
  const out = tempDir("out-go");
  const dist = fakeDist();
  packageRelease({ version: "0.35.0", distDir: dist, outDir: out, npmDir: join(root, "npm") });

  test("every platform's archive yields its binary to the 0.34.1 picker", () => {
    for (const p of PLATFORMS) {
      const goos = p.npm.startsWith("win-")
        ? "windows"
        : p.npm.startsWith("darwin-")
          ? "darwin"
          : "linux";
      expect(goUpdatePick(join(out, "assets", `knowns-${p.npm}.tar.gz`), goos)).toBe(
        `binary:${p.dist}`,
      );
    }
  });

  test("without the update entry the picker takes the Windows archive itself", () => {
    const p = PLATFORMS.find((x) => x.npm === "win-x64");
    if (!p) throw new Error("win-x64 missing");
    const archive = join(tempDir("bare"), `knowns-${p.npm}.tar.gz`);
    run(["tar", "-czf", archive, "-C", join(dist, p.dist), "./knowns.exe"]);
    expect(goUpdatePick(archive, "windows")).not.toBe(`binary:${p.dist}`);
  });
});

describe("package-release npm output", () => {
  const out = tempDir("out");
  packageRelease({
    version: "v1.0.0",
    distDir: fakeDist(),
    outDir: out,
    npmDir: join(root, "npm"),
    installDir: join(root, "install"),
  });

  test("platform packages are versioned 1.0.0 and the wrapper pins all six", () => {
    for (const p of PLATFORMS) {
      const pkg = JSON.parse(
        readFileSync(join(out, "npm", `knowns-${p.npm}`, "package.json"), "utf8"),
      );
      expect(pkg.name).toBe(`@knowns/${p.npm}`);
      expect(pkg.version).toBe("1.0.0");
      expect(pkg.files).toEqual([p.exe]);
      expect(existsSync(join(out, "npm", `knowns-${p.npm}`, p.exe))).toBe(true);
    }
    const wrapper = JSON.parse(readFileSync(join(out, "npm", "knowns", "package.json"), "utf8"));
    expect(wrapper.version).toBe("1.0.0");
    expect(Object.keys(wrapper.optionalDependencies).sort()).toEqual(
      PLATFORMS.map((p) => `@knowns/${p.npm}`).sort(),
    );
    expect(new Set(Object.values(wrapper.optionalDependencies))).toEqual(new Set(["1.0.0"]));
    expect(existsSync(join(out, "npm", "knowns", "install.test.js"))).toBe(false);
  });

  test("install scripts are copied next to the assets", () => {
    for (const f of ["install.sh", "install.ps1", "uninstall.sh", "uninstall.ps1"]) {
      expect(existsSync(join(out, "assets", f))).toBe(true);
    }
  });
});

describe("AC2: 0.34.x stays on the Go release layout", () => {
  test("npm wrapper builds the 0.34.1 Go release URLs (Go shipped 5 platforms, no win-arm64)", () => {
    for (const [plat, arch, asset] of [
      ["darwin", "arm64", "darwin-arm64"],
      ["darwin", "x64", "darwin-x64"],
      ["linux", "x64", "linux-x64"],
      ["linux", "arm64", "linux-arm64"],
      ["win32", "x64", "win-x64"],
    ]) {
      expect(releaseAssetUrl(getPlatformPackage(plat, arch), "0.34.1")).toBe(
        `https://github.com/knowns-dev/knowns/releases/download/v0.34.1/knowns-${asset}.tar.gz`,
      );
    }
  });
  test("package names did not change between Go and TS releases", () => {
    expect(PLATFORMS.map((p) => `@knowns/${p.npm}`).sort()).toEqual(
      ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win-arm64", "win-x64"].map(
        (s) => `@knowns/${s}`,
      ),
    );
  });
});

describe("AC5: version comes from the release tag", () => {
  test("cli/package.json carries no version", () => {
    const pkg = JSON.parse(readFileSync(join(root, "cli/package.json"), "utf8"));
    expect(pkg.version).toBeUndefined();
  });
  test("resolveVersion: env wins, then exact git tag, then the untagged fallback; v prefix stripped", () => {
    expect(resolveVersion({ KNOWNS_VERSION: "v1.2.3" }, () => "v9.9.9")).toBe("1.2.3");
    expect(resolveVersion({}, () => "v1.0.0")).toBe("1.0.0");
    expect(resolveVersion({}, () => undefined)).toBe(UNTAGGED_VERSION);
  });
  test("a compiled binary reports `knowns version <injected>`", async () => {
    const os = process.platform === "win32" ? "windows" : process.platform;
    const target = `bun-${os}-${process.arch}`;
    const out = join(tempDir("bin"), os === "windows" ? "knowns.exe" : "knowns");
    const built = run(
      [
        "bun",
        join(import.meta.dir, "compile-one.ts"),
        join(root, "cli/src/bin.ts"),
        target,
        out,
        "1.0.0",
      ],
      undefined,
      join(root, "cli"),
    );
    expect(built.stderr).toBe("");
    const r = run([out, "--version"], {
      ...(process.env as Record<string, string>),
      NO_UPDATE_CHECK: "1",
    });
    expect(r.stdout).toBe("knowns version 1.0.0\n");
  }, 180_000);
});
