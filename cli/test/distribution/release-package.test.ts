// AC1/AC2/AC5 of TSR-Z7CRS1: packaging maps Bun dist names to npm package names for all six
// platforms, release asset names match the Go releases, and the version comes from the tag.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { PLATFORMS, packageRelease, sha256File } from "../../../scripts/package-release.ts";
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
      expect(run(["tar", "-tzf", archive]).stdout.trim()).toBe(`./${p.exe}`);
      const sum = readFileSync(`${archive}.sha256`, "utf8");
      expect(sum).toBe(`${sha256File(archive)}  knowns-${p.npm}.tar.gz\n`);
    }
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
