// Subprocess entry for release-package.test.ts: Bun.build misresolves some imports when it runs
// inside the `bun test` process, so the compile happens in a plain bun process.
import { compile } from "../../scripts/lib.ts";

const [entry, target, out, version] = process.argv.slice(2);
if (!entry || !target || !out || !version) {
  console.error("usage: compile-one.ts <entry> <target> <outfile> <version>");
  process.exit(2);
}
await compile(entry, target, out, { KNOWNS_VERSION: JSON.stringify(version) });
