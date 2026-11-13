// Builds and drives cli/test/search/search-helper.go, which calls the real Go internal/search
// code. Tests that need it are skipped when no Go toolchain is available.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..", "..");
const SOURCE = join(import.meta.dir, "search-helper.go");
const OUT_DIR = join(tmpdir(), "knowns-ts-test-search-helper");

let built: string | undefined | null = null;

export function searchHelperPath(): string | undefined {
  if (built !== null) return built;
  const exe = join(OUT_DIR, process.platform === "win32" ? "search-helper.exe" : "search-helper");
  mkdirSync(OUT_DIR, { recursive: true });
  if (existsSync(exe) && statSync(exe).mtimeMs > statSync(SOURCE).mtimeMs) {
    built = exe;
    return built;
  }
  const res = Bun.spawnSync(["go", "build", "-o", exe, SOURCE], {
    cwd: REPO,
    stderr: "pipe",
    stdout: "pipe",
  });
  built = res.exitCode === 0 ? exe : undefined;
  if (!built) console.warn(`search helper unavailable: ${res.stderr.toString().slice(0, 300)}`);
  return built;
}

export const hasSearchHelper = (): boolean => searchHelperPath() !== undefined;

type Response = { ok: unknown } | { error: string };

/** Sends requests to the helper and returns the `ok` payload of each (throws on `error`). */
export function askGo(requests: Record<string, unknown>[]): unknown[] {
  const exe = searchHelperPath();
  if (!exe) throw new Error("search helper unavailable");
  const res = Bun.spawnSync([exe], {
    stdin: new TextEncoder().encode(JSON.stringify(requests)),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) throw new Error(`search helper failed: ${res.stderr.toString()}`);
  const out = JSON.parse(res.stdout.toString()) as Response[];
  return out.map((r) => {
    if ("error" in r) throw new Error(r.error);
    return r.ok;
  });
}

export function askGoOne(request: Record<string, unknown>): unknown {
  return askGo([request])[0];
}
