// os-regression-inventory row 18 (75b0470, update.go): `knowns update` resolves the executable
// through symlinks before it guesses the install method, so an install.sh binary linked into
// /opt/homebrew/bin is not mistaken for Homebrew. Every layout lives under a temp root that mimics
// the real paths (<root>/opt/homebrew/bin, <root>/home/.knowns/bin); nothing is installed outside
// it and no network is used.
//
// Three levels: the detector with the path injected; a compiled TS helper that feeds the real
// `updateSeams.executable()` (process.execPath) to it while being invoked through the symlink;
// and the same invocation of a Go helper calling util.DetectInstallMethod (os.Executable), so the
// two are diffed on identical layouts.
//
// Note: a compiled Bun binary's process.execPath is already the resolved path (checked on macOS),
// while Go's os.Executable returns the symlink. So the compiled-TS level proves the command's
// verdict end to end, and the detector's own symlink resolution is proven by the injected-path
// cases plus the Go diff (where the symlink path really reaches the detector).
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  detectInstallMethodFor,
  type InstallMethod,
} from "../../../src/domain/update/install-method.ts";
import { goTool } from "../../stores/cfg-go.ts";

const posix = process.platform !== "win32";
const SRC = resolve(import.meta.dir, "../../../src");

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `knowns-${prefix}-`)));
}

interface Layout {
  name: string;
  /** Where the real binary lives, relative to the root. */
  real: string;
  /** The symlink the user runs, relative to the root. */
  link: string;
  method: InstallMethod;
}

// HOME is <root>/home in every case.
const LAYOUTS: Layout[] = [
  {
    name: "install.sh binary linked into /opt/homebrew/bin",
    real: "home/.knowns/bin/knowns",
    link: "opt/homebrew/bin/knowns",
    method: "script",
  },
  {
    name: "install.sh binary linked into ~/.local/bin",
    real: "home/.knowns/bin/knowns",
    link: "home/.local/bin/knowns",
    method: "script",
  },
  {
    name: "kn alias in /opt/homebrew/bin pointing at the install.sh binary",
    real: "home/.knowns/bin/knowns",
    link: "opt/homebrew/bin/kn",
    method: "script",
  },
  {
    name: "real Homebrew keg linked into /opt/homebrew/bin",
    real: "opt/homebrew/Cellar/knowns/1.0.0/bin/knowns",
    link: "opt/homebrew/bin/knowns",
    method: "brew",
  },
  {
    name: "npm global package linked into /usr/local/bin",
    real: "usr/local/lib/node_modules/knowns/bin/knowns",
    link: "usr/local/bin/knowns",
    method: "npm",
  },
];

/** Builds the layout under a fresh root with `binary` (or a stub) at `real`. */
function build(l: Layout, binary?: string): { root: string; home: string; link: string } {
  const root = tmp("row18");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const real = join(root, l.real);
  mkdirSync(dirname(real), { recursive: true });
  if (binary) copyFileSync(binary, real);
  else writeFileSync(real, "#!/bin/sh\n");
  chmodSync(real, 0o755);
  const link = join(root, l.link);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(real, link);
  return { root, home, link };
}

/** No install.json, no package-manager user agent: only the path can decide. */
const envFor = (home: string): Record<string, string> => ({
  HOME: home,
  USERPROFILE: home,
  PATH: "/usr/bin:/bin",
  NO_UPDATE_CHECK: "1",
});

describe.skipIf(!posix)("row 18: install method is detected from the resolved executable", () => {
  for (const l of LAYOUTS) {
    test(`${l.name} -> ${l.method}`, () => {
      const { home, link } = build(l);
      const got = detectInstallMethodFor(link, { env: envFor(home), metadata: null });
      expect(got.method).toBe(l.method);
    });
  }

  test("without resolving, the /opt/homebrew/bin path alone would read as Homebrew", () => {
    // Guards the test itself: the symlink path really is a Homebrew-looking path, so the
    // script verdict above comes from following the link, not from an unrelated rule.
    const l = LAYOUTS[0] as Layout;
    const { home, link } = build(l);
    const dangling = join(dirname(link), "knowns-unresolvable");
    const got = detectInstallMethodFor(dangling, { env: envFor(home), metadata: null });
    expect(got.method).toBe("brew");
  });

  test("a symlinked HOME/.knowns/bin still counts as the script dir", () => {
    const root = tmp("row18-home");
    const realBin = join(root, "data", "knowns-bin");
    mkdirSync(realBin, { recursive: true });
    writeFileSync(join(realBin, "knowns"), "#!/bin/sh\n", { mode: 0o755 });
    const home = join(root, "home");
    mkdirSync(join(home, ".knowns"), { recursive: true });
    symlinkSync(realBin, join(home, ".knowns", "bin"));
    const link = join(root, "opt", "homebrew", "bin", "knowns");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(home, ".knowns", "bin", "knowns"), link);
    const got = detectInstallMethodFor(link, { env: envFor(home), metadata: null });
    expect(got.method).toBe("script");
  });
});

// --- Through the real executable seams, diffed against Go ---------------------------------------

const GO_SOURCE = `package main

import (
	"fmt"

	"github.com/howznguyen/knowns/internal/util"
)

func main() {
	m, cmd := util.DetectInstallMethod()
	fmt.Printf("%s\\t%s\\n", m, cmd)
}
`;

let tsHelper: string | null | undefined = null;
/** A compiled binary that runs the update command's executable seam through the detector. */
function compiledTsHelper(): string | undefined {
  if (tsHelper !== null) return tsHelper;
  const dir = tmp("row18-ts");
  const entry = join(dir, "entry.ts");
  writeFileSync(
    entry,
    `import { updateSeams } from ${JSON.stringify(join(SRC, "cli/commands/update.ts"))};
import { detectInstallMethodFor } from ${JSON.stringify(join(SRC, "domain/update/install-method.ts"))};
const d = detectInstallMethodFor(updateSeams.executable(), { env: process.env });
console.log(d.method + "\\t" + d.command);
`,
  );
  const out = join(dir, "detect");
  // Compiled in a child bun: Bun.build inside the test process misresolves some imports.
  const r = Bun.spawnSync(["bun", "build", "--compile", entry, "--outfile", out], {
    cwd: resolve(SRC, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    console.warn(`ts helper compile failed: ${r.stderr.toString().slice(0, 400)}`);
    tsHelper = undefined;
  } else {
    if (process.platform === "darwin") {
      Bun.spawnSync(["codesign", "--remove-signature", out]);
      Bun.spawnSync(["codesign", "-s", "-", "-f", out]);
    }
    tsHelper = out;
  }
  return tsHelper;
}

const hasGo = posix && Bun.which("go") !== null;

describe.skipIf(!posix)("row 18 through the executable seam (compiled TS)", () => {
  for (const l of LAYOUTS) {
    test(`${l.name}: process.execPath via the symlink -> ${l.method}`, () => {
      const helper = compiledTsHelper();
      expect(helper).toBeDefined();
      const { home, link } = build(l, helper);
      const r = Bun.spawnSync([link], { env: envFor(home), stdout: "pipe", stderr: "pipe" });
      expect(r.stderr.toString()).toBe("");
      expect(r.stdout.toString().split("\t")[0]).toBe(l.method);
    }, 120_000);
  }
});

describe.skipIf(!hasGo)("row 18 matches Go util.DetectInstallMethod", () => {
  for (const l of LAYOUTS) {
    test(`${l.name}: Go and TS print the same method and command`, () => {
      const go = goTool("row18-detect", GO_SOURCE);
      const ts = compiledTsHelper();
      expect(go).toBeDefined();
      expect(ts).toBeDefined();
      const goRun = build(l, go);
      const tsRun = build(l, ts);
      const g = Bun.spawnSync([goRun.link], { env: envFor(goRun.home), stdout: "pipe" });
      const t = Bun.spawnSync([tsRun.link], { env: envFor(tsRun.home), stdout: "pipe" });
      expect(g.exitCode).toBe(0);
      expect(t.stdout.toString()).toBe(g.stdout.toString());
      expect(g.stdout.toString().split("\t")[0]).toBe(l.method);
    }, 180_000);
  }
});
