// go-winres is pinned in proxy/go.mod (with hashes in go.sum), not fetched at build time by a bare
// `go run pkg@version`, and it is not linked into the proxy.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GO_WINRES, PROXY_DIR } from "../../scripts/proxy.ts";

test("go-winres is a go.mod tool dependency with a go.sum entry", () => {
  const mod = readFileSync(join(PROXY_DIR, "go.mod"), "utf8");
  const sum = readFileSync(join(PROXY_DIR, "go.sum"), "utf8");
  expect(mod).toMatch(/^tool github\.com\/tc-hib\/go-winres$/m);
  expect(mod).toMatch(/github\.com\/tc-hib\/go-winres v\d+\.\d+\.\d+/);
  expect(sum).toContain("github.com/tc-hib/go-winres v");
  expect(GO_WINRES).toBe("go-winres");
});
