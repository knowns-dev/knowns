// Approved divergence (D12, TSR-Q7B522): the git calls behind /api/imports are killed after a
// limit (5 minutes). 0.34.1 relied on its http.Server write timeout, which the TS server cannot
// use (SSE needs idleTimeout 0), so a slow or huge remote would hold a request and a git process
// forever. A fake `git` that never finishes stands in for the remote; the limit is shortened.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { git, importsGitLimits } from "../../src/server/routes/imports.ts";

const saved = { path: process.env.PATH, timeout: importsGitLimits.timeoutMs };
const dirs: string[] = [];
afterEach(() => {
  process.env.PATH = saved.path;
  importsGitLimits.timeoutMs = saved.timeout;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("imports git calls", () => {
  test("a git call that never finishes is killed at the limit", async () => {
    const bin = mkdtempSync(join(tmpdir(), "knowns-fake-git-"));
    dirs.push(bin);
    const fake = join(bin, "git");
    writeFileSync(fake, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(fake, 0o755);
    process.env.PATH = `${bin}${delimiter}${saved.path ?? ""}`;
    importsGitLimits.timeoutMs = 200;
    const started = Date.now();
    const outcome = await Promise.race([
      git(["ls-remote", "https://example.invalid/repo.git"]).then((r) => ({ killed: true, r })),
      Bun.sleep(5000).then(() => ({ killed: false, r: undefined })),
    ]);
    expect(outcome.killed).toBe(true);
    expect(outcome.r?.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
