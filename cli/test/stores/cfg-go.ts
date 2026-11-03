// Go binary and throwaway Go tools for the config/registry/embedding store tests.
// KNOWNS_GO_BIN wins; otherwise the CLI is built once into the OS temp dir. Tools are compiled
// with `go build -overlay`, so a temporary main package can import the repo's internal packages
// without adding a file to the repository.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..", "..");
const OUT = join(tmpdir(), "knowns-ts-test-cfg-go");

let cliBin: string | undefined | null = null;

export function goCli(): string | undefined {
  if (cliBin !== null) return cliBin;
  const fromEnv = process.env.KNOWNS_GO_BIN;
  if (fromEnv) {
    cliBin = resolve(fromEnv);
    return cliBin;
  }
  mkdirSync(OUT, { recursive: true });
  const exe = join(OUT, "knowns");
  if (!existsSync(exe)) {
    const res = Bun.spawnSync(
      [
        "go",
        "build",
        "-ldflags",
        "-X github.com/howznguyen/knowns/internal/util.Version=0.34.1",
        "-o",
        exe,
        "./cmd/knowns",
      ],
      { cwd: REPO, stdout: "pipe", stderr: "pipe" },
    );
    if (res.exitCode !== 0) {
      console.warn(`go build failed: ${res.stderr.toString().slice(0, 300)}`);
      cliBin = undefined;
      return cliBin;
    }
  }
  cliBin = exe;
  return cliBin;
}

export const hasGoCli = (): boolean => goCli() !== undefined;

export function goEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: "1",
    NO_UPDATE_CHECK: "1",
  };
}

export function runGo(
  args: string[],
  cwd: string,
  home: string,
): { code: number; out: string; err: string } {
  const res = Bun.spawnSync([goCli() as string, ...args], {
    cwd,
    env: goEnv(home),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: res.exitCode, out: res.stdout.toString(), err: res.stderr.toString() };
}

const tools = new Map<string, string | undefined>();

/** Compile a main package that may import github.com/howznguyen/knowns/internal/...; cached. */
export function goTool(name: string, source: string): string | undefined {
  if (tools.has(name)) return tools.get(name);
  mkdirSync(OUT, { recursive: true });
  const dir = mkdtempSync(join(OUT, `${name}-`));
  const src = join(dir, "main.go");
  writeFileSync(src, source);
  const virtual = join(REPO, "cmd", `zz-${name}`, "main.go");
  const overlay = join(dir, "overlay.json");
  writeFileSync(overlay, JSON.stringify({ Replace: { [virtual]: src } }));
  const exe = join(dir, name);
  const res = Bun.spawnSync(["go", "build", "-overlay", overlay, "-o", exe, `./cmd/zz-${name}`], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = res.exitCode === 0 ? exe : undefined;
  if (!out) console.warn(`go tool ${name} failed: ${res.stderr.toString().slice(0, 400)}`);
  tools.set(name, out);
  return out;
}
