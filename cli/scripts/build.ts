import { join, resolve } from "node:path";
import { compile, exeName, platformOf, TARGETS } from "./lib.ts";
import { buildLauncher, haveGo, launcherExeName } from "./proxy.ts";
import { resolveVersion } from "./version.ts";

const cliDir = resolve(import.meta.dir, "..");

const gen = Bun.spawnSync(["bun", "scripts/gen-ui-assets.ts"], {
  cwd: cliDir,
  stdout: "inherit",
  stderr: "inherit",
});
if (gen.exitCode !== 0) process.exit(gen.exitCode ?? 1);

// `bun run build` builds all targets; `bun run build bun-linux-x64 ...` builds a subset.
const wanted = process.argv.slice(2);
const list: string[] = wanted.length > 0 ? wanted : [...TARGETS];
const version = resolveVersion();
console.log(`version ${version}`);
let failed = 0;
// The Go launcher (knowns.launcher) ships next to the engine (dist/<platform>/knowns, installed as
// knowns-engine). CI always has Go; a local build without it warns and skips
// (KNOWNS_REQUIRE_PROXY=1 makes that an error), and the engine still works on its own.
const goOk = haveGo();
if (!goOk) console.warn("warn go not found: knowns.launcher is not built");
if (!goOk && process.env.KNOWNS_REQUIRE_PROXY === "1") process.exit(1);

for (const target of list) {
  const out = join(cliDir, "dist", platformOf(target), exeName(target));
  try {
    await compile(
      join(cliDir, "src", "bin.ts"),
      target,
      out,
      { KNOWNS_VERSION: JSON.stringify(version) },
      {
        releaseVersion: version,
        workers: [
          join(cliDir, "src", "mcp", "search-worker.ts"),
          join(cliDir, "src", "runtime", "runner-worker-entry.ts"),
        ],
      },
    );
    console.log(`ok   ${target} -> dist/${platformOf(target)}/${exeName(target)}`);
    if (goOk) {
      buildLauncher(
        target,
        version,
        join(cliDir, "dist", platformOf(target), launcherExeName(target)),
      );
      console.log(`ok   ${target} -> dist/${platformOf(target)}/${launcherExeName(target)}`);
    }
  } catch (e) {
    failed++;
    console.error(`FAIL ${target}: ${e}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
