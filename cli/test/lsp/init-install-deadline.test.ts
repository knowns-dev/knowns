// Approved divergence (D12, TSR-XSEKND): during `knowns init`, each language-server download gets a
// deadline (10 minutes; shortened here). 0.34.1 used context.Background(), so a stalled mirror
// hung init forever. A fake adapter whose download never finishes on its own stands in.
import { afterEach, expect, test } from "bun:test";
import { installWithDeadline, lspInitInstallLimits } from "../../src/lsp/auto-install.ts";

const saved = lspInitInstallLimits.timeoutMs;
afterEach(() => {
  lspInitInstallLimits.timeoutMs = saved;
});

/** Resolves only if the context is aborted, the way a real download aborts its fetch. */
const stalled = {
  install: (ctx: AbortSignal) =>
    new Promise<string>((_, reject) => {
      ctx.addEventListener("abort", () => reject(ctx.reason), { once: true });
    }),
};

test("a stalled language-server download is abandoned at the deadline", async () => {
  lspInitInstallLimits.timeoutMs = 100;
  const outcome = await Promise.race([
    installWithDeadline(stalled, "/unused").then(
      () => "installed",
      (e: Error) => e.message,
    ),
    Bun.sleep(3000).then(() => "still waiting"),
  ]);
  expect(outcome).toBe("context deadline exceeded");
});

test("a download that finishes in time returns its path", async () => {
  const path = await installWithDeadline({ install: async () => "/bin/server" }, "/unused");
  expect(path).toBe("/bin/server");
});
