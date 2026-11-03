import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../src/main.ts";
import { getUiAsset } from "../src/ui.ts";
import { VERSION } from "../src/version.ts";

test("parseArgs validates input", () => {
  expect(parseArgs(["--version"]).version).toBe(true);
  expect(() => parseArgs(["--debug-ui-asset"])).not.toThrow();
});

test("embedded ui index.html is readable", async () => {
  const html = await getUiAsset("/")?.text();
  expect(html).toContain("<html");
  expect(getUiAsset("/nope.txt")).toBeNull();
});

const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const exe = join(
  import.meta.dir,
  "..",
  "dist",
  platform,
  process.platform === "win32" ? "knowns.exe" : "knowns",
);

test.skipIf(!existsSync(exe))("compiled binary prints version and serves embedded ui", () => {
  const v = Bun.spawnSync([exe, "--version"]);
  expect(v.stdout.toString()).toBe(`knowns version ${VERSION}\n`);
  const a = Bun.spawnSync([exe, "--debug-ui-asset", "index.html"]);
  expect(a.exitCode).toBe(0);
  expect(a.stdout.toString()).toMatch(/^\d+ text\/html/);
});
