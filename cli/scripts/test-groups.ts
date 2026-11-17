// Runs the unit tests in a few separate `bun test` processes, one after another.
//
// Why: on the Windows CI runner a single `bun test` over the whole suite ran for ~280 s and then
// Bun 1.3.12 itself panicked ("Internal assertion failure", exit 3) right after
// test/runtime/ui-host.test.ts. Shorter-lived processes keep each run well under that point.
// Every group keeps the suite-wide `--timeout 30000` (see package.json "test").
//
// Groups are made from the entries of test/: the named heavy directories go to their group, and
// everything else (including a directory or file added later) lands in the last group, so no test
// can fall out of the run. `bun scripts/test-groups.ts --list` prints the groups.
import { readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const testDir = join(root, "test");

const NAMED: Array<{ name: string; dirs: string[] }> = [
  { name: "runtime", dirs: ["runtime"] },
  { name: "servers", dirs: ["server", "mcp", "lsp", "lspdaemon", "tui", "wiring"] },
];

export function groups(entries: string[]): Array<{ name: string; paths: string[] }> {
  const taken = new Set(NAMED.flatMap((g) => g.dirs));
  const named = NAMED.map((g) => ({
    name: g.name,
    // The trailing slash keeps "./test/lsp/" from also matching "./test/lspdaemon/".
    paths: g.dirs.filter((d) => entries.includes(d)).map((d) => `./test/${d}/`),
  }));
  const rest = entries
    .filter((e) => !taken.has(e) && e !== "fixtures")
    .map((e) => (e.endsWith(".test.ts") ? `./test/${e}` : `./test/${e}/`));
  return [...named, { name: "rest", paths: rest }].filter((g) => g.paths.length > 0);
}

if (import.meta.main) {
  const all = groups(readdirSync(testDir).sort());
  if (process.argv.includes("--list")) {
    for (const g of all) console.log(`${g.name}: ${g.paths.join(" ")}`);
    process.exit(0);
  }
  const extra = process.argv.slice(2);
  let failed = 0;
  for (const g of all) {
    console.log(`\n=== bun test group "${g.name}" (${g.paths.length} paths) ===`);
    const r = Bun.spawnSync(
      [process.execPath, "test", "--timeout", "30000", ...extra, ...g.paths],
      { cwd: root, stdout: "inherit", stderr: "inherit", stdin: "inherit" },
    );
    if (r.exitCode !== 0) {
      failed++;
      console.log(`=== group "${g.name}" exited with code ${r.exitCode} ===`);
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}
