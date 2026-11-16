// Builds the native MCP proxy (proxy/, a separate Go module) for the release targets. The proxy
// ships next to knowns in every package as knowns-proxy[.exe] (spec mcp-thin-proxy D8, FR-11).
// CGO is off, so every target cross-compiles from any host; only the Windows resource (icon and
// version info) needs a build-time tool, go-winres, which is never a dependency of the proxy.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { platformOf, windowsFileVersion } from "./lib.ts";

export const PROXY_DIR = resolve(import.meta.dir, "..", "..", "proxy");
export const GO_WINRES = "github.com/tc-hib/go-winres@v0.3.3";
const ICON = join(import.meta.dir, "assets", "knowns.ico");

export function proxyExeName(target: string): string {
  return platformOf(target).startsWith("windows") ? "knowns-proxy.exe" : "knowns-proxy";
}

/** bun-darwin-arm64 -> { goos: "darwin", goarch: "arm64" }. */
export function goTarget(target: string): { goos: string; goarch: string } {
  const m = /^(?:bun-)?(darwin|linux|windows)-(x64|arm64)$/.exec(target);
  if (!m) throw new Error(`unsupported proxy target ${target}`);
  return { goos: m[1] as string, goarch: m[2] === "x64" ? "amd64" : "arm64" };
}

/** go build arguments for one target; pure so tests can check the flags. */
export function goBuildArgs(version: string, outfile: string): string[] {
  return ["build", "-trimpath", "-ldflags", `-s -w -X main.version=${version}`, "-o", outfile, "."];
}

function run(cmd: string[], cwd: string, env: Record<string, string> = {}): void {
  const r = Bun.spawnSync(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${r.exitCode})`);
}

/** Writes proxy/rsrc_windows_{amd64,arm64}.syso so the Windows exe says Knowns, like knowns.exe. */
export function generateWindowsResource(version: string, dir: string = PROXY_DIR): void {
  const fv = windowsFileVersion(version);
  run(
    [
      "go",
      "run",
      GO_WINRES,
      "simply",
      "--arch",
      "amd64,arm64",
      "--icon",
      ICON,
      "--manifest",
      "invoker",
      "--file-version",
      fv,
      "--product-version",
      fv,
      "--file-description",
      "Knowns",
      "--product-name",
      "Knowns",
      "--company-name",
      "Knowns",
      "--copyright",
      "Copyright (c) Knowns contributors",
      "--original-filename",
      "knowns-proxy.exe",
      "--out",
      join(dir, "rsrc"),
    ],
    dir,
  );
}

export function removeWindowsResource(dir: string = PROXY_DIR): void {
  for (const f of readdirSync(dir)) if (/^rsrc_windows_.*\.syso$/.test(f)) rmSync(join(dir, f));
}

export function haveGo(): boolean {
  try {
    return Bun.spawnSync(["go", "version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
}

/** Builds the proxy for `target` into `outfile`. */
export function buildProxy(target: string, version: string, outfile: string): void {
  const { goos, goarch } = goTarget(target);
  mkdirSync(dirname(outfile), { recursive: true });
  const windows = goos === "windows";
  if (windows) generateWindowsResource(version);
  try {
    run(["go", ...goBuildArgs(version, outfile)], PROXY_DIR, {
      CGO_ENABLED: "0",
      GOOS: goos,
      GOARCH: goarch,
    });
  } finally {
    if (windows) removeWindowsResource();
  }
}
