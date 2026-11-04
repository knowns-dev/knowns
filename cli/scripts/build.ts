import { join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { compile, exeName, platformOf, TARGETS } from "./lib.ts";

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
const version = process.env.KNOWNS_VERSION ?? pkg.version;
let failed = 0;

for (const target of list) {
  const out = join(cliDir, "dist", platformOf(target), exeName(target));
  try {
    await compile(join(cliDir, "src", "bin.ts"), target, out, {
      KNOWNS_VERSION: JSON.stringify(version),
    });
    console.log(`ok   ${target} -> dist/${platformOf(target)}/${exeName(target)}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${target}: ${e}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
