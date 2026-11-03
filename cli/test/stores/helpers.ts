// Shared helpers for the entity store tests.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { Store } from "../../src/storage/core/store.ts";
import { fixtureRoot } from "../helpers/fixtures.ts";

const REPO = resolve(import.meta.dir, "..", "..", "..");
const OUT = join(tmpdir(), "knowns-ts-test-stores-go");

let cliBin: string | undefined | null = null;

/** The Go 0.34.1 CLI: KNOWNS_GO_BIN, else built once into the temp dir; undefined without Go. */
export function goCli(): string | undefined {
  if (cliBin !== null) return cliBin;
  const fromEnv = process.env.KNOWNS_GO_BIN;
  if (fromEnv) {
    cliBin = resolve(fromEnv);
    return cliBin;
  }
  mkdirSync(OUT, { recursive: true });
  const exe = join(OUT, process.platform === "win32" ? "knowns.exe" : "knowns");
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

export const hasGo = (): boolean => goCli() !== undefined;

export function tmp(prefix = "knowns-stores-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A git-initialised project dir plus an isolated HOME. */
export function sandbox(): { home: string; project: string; root: string } {
  const root = tmp();
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", "."], { cwd: project });
  return { home, project, root };
}

export function goEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    TZ: "UTC",
    NO_COLOR: "1",
    NO_UPDATE_CHECK: "1",
    CI: "1",
    KNOWN_LSP_AUTO_INSTALL: "0",
    KNOWNS_RUNTIME_INLINE: "1",
    KNOWNS_SEMANTIC_RUNTIME_DISABLED: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

export function runGo(args: string[], cwd: string, home: string, allowFail = false): string {
  const bin = goCli();
  if (!bin) throw new Error("go binary unavailable");
  const res = Bun.spawnSync([bin, ...args], { cwd, env: goEnv(home) });
  const out = res.stdout.toString();
  if (res.exitCode !== 0 && !allowFail) {
    throw new Error(
      `knowns ${args.join(" ")} exited ${res.exitCode}:\n${out}${res.stderr.toString()}`,
    );
  }
  return out;
}

export function goJson<T = unknown>(args: string[], cwd: string, home: string): T {
  return JSON.parse(runGo([...args, "--json"], cwd, home)) as T;
}

/** Copy a golden fixture into a fresh temp dir; returns the project dir and its isolated HOME. */
export function copyFixture(name: string): { project: string; home: string; root: string } {
  const root = tmp();
  const project = join(root, "project");
  const home = join(root, "home");
  cpSync(fixtureRoot(name), project, {
    recursive: true,
    filter: (src) => !src.split(sep).includes("_api") && !src.split(sep).includes("_home"),
  });
  mkdirSync(home, { recursive: true });
  const globalHome = join(fixtureRoot(name), "_home");
  if (existsSync(globalHome)) cpSync(globalHome, home, { recursive: true });
  return { project, home, root };
}

export function storeAt(project: string): Store {
  return Store.open(join(project, ".knowns"));
}

/** All files under dir as forward-slash relative path -> content. */
export function readTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const entry of readdirSync(d).sort()) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p).split(sep).join("/"), readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out;
}
