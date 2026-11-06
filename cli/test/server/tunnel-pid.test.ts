// Beyond Go (review of TSR-Q7B522): `tunnel stop` signals the pid in ~/.knowns/cloudflared-<port>.pid.
// A file holding 0, 1 or a negative number would signal a process group, init or every process the
// user owns; such a file is now discarded without signalling anything.
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Daemon } from "../../src/server/tunnel.ts";

const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

for (const bad of ["-1", "0", "1"]) {
  test(`a pid file holding ${bad} is discarded without signalling`, async () => {
    const home = mkdtempSync(join(tmpdir(), "tunnel-pid-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const d = new Daemon(47999);
    mkdirSync(dirname(d.pidFile), { recursive: true });
    writeFileSync(d.pidFile, bad);
    const kill = spyOn(process, "kill");
    try {
      await d.stop();
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
    expect(existsSync(d.pidFile)).toBe(false);
  });
}
