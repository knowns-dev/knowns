// createStorage wires the personal/machine config split exactly where Go does (store.go): only for
// a knowledge root inside a store folder. An in-repo .knowns/ keeps every setting in config.json,
// so storage.config.set must work there without the project being linked to a store.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorage } from "../../src/storage/adapters.ts";
import { Store } from "../../src/storage/core/store.ts";

const tmp = mkdtempSync(join(tmpdir(), "knowns-adapters-split-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("createStorage config split", () => {
  test("an in-repo project sets a settings key straight into config.json", () => {
    const repo = join(tmp, "repo");
    cpSync(join(import.meta.dir, "..", "fixtures", "full"), repo, { recursive: true });
    const root = join(repo, ".knowns");
    const storage = createStorage(new Store(root, repo));
    expect(() => storage.config.set("settings.defaultPriority", "high")).not.toThrow();
    const cfg = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
    expect(cfg.settings.defaultPriority).toBe("high");
  });
});
