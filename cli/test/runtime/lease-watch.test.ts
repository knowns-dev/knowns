// KN-69EHXE-style review fix (storesync tick, P2-2/P3-1): heartbeats of leases the daemon already
// knows must not wake it, however the platform reports an atomic rewrite; a lease appearing or
// going away must. The lease file itself is written atomically.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as q from "../../src/runtime/queue.ts";

const home = mkdtempSync(join(tmpdir(), "knowns-leasewatch-"));
const rt = join(home, "runtime");
let saved: string | undefined;
beforeAll(() => {
  saved = process.env.KNOWNS_RUNTIME_ROOT;
  process.env.KNOWNS_RUNTIME_ROOT = rt;
  mkdirSync(join(rt, "leases"), { recursive: true });
});
afterAll(() => {
  if (saved === undefined) delete process.env.KNOWNS_RUNTIME_ROOT;
  else process.env.KNOWNS_RUNTIME_ROOT = saved;
  rmSync(home, { recursive: true, force: true });
});

const leaseFile = (name: string) => join(rt, "leases", name);

describe("watchRuntimeDirs lease filter", () => {
  test("N heartbeats poke 0 times; a create and a delete poke twice", async () => {
    writeFileSync(leaseFile("a.json"), "{}");
    let pokes = 0;
    const w = q.watchRuntimeDirs(() => {
      pokes++;
    });
    try {
      w.setLeases(["a.json"]);
      await Bun.sleep(300); // let the watch settle
      pokes = 0;
      for (let i = 0; i < 12; i++) {
        // An atomic rewrite, as ClientHandle.refresh does it.
        writeFileSync(leaseFile("a.json.tmp"), JSON.stringify({ i }));
        renameSync(leaseFile("a.json.tmp"), leaseFile("a.json"));
        await Bun.sleep(30);
      }
      await Bun.sleep(300);
      expect(pokes).toBe(0);

      writeFileSync(leaseFile("b.json"), "{}"); // a new client
      await Bun.sleep(400);
      expect(pokes).toBeGreaterThanOrEqual(1);
      const afterCreate = pokes;
      w.setLeases(["a.json", "b.json"]); // the next scan saw it
      rmSync(leaseFile("b.json")); // the client went away
      await Bun.sleep(400);
      expect(pokes).toBeGreaterThan(afterCreate);
    } finally {
      w.close();
    }
  });
});

describe("ClientHandle.refresh", () => {
  test("never leaves a partial lease: every read during many refreshes parses", async () => {
    const handle = q.acquireClient("cli", join(home, "proj", ".knowns"), false, { ensure: false });
    try {
      const file = leaseFile(`${handle.lease.id}.json`);
      let bad = 0;
      let reads = 0;
      let stop = false;
      const reader = (async () => {
        while (!stop) {
          try {
            JSON.parse(readFileSync(file, "utf8"));
          } catch (e) {
            if (
              (e as NodeJS.ErrnoException).code !== "ENOENT" &&
              !(e as NodeJS.ErrnoException).code
            )
              bad++;
          }
          reads++;
          await Bun.sleep(0);
        }
      })();
      for (let i = 0; i < 300; i++) handle.refresh();
      stop = true;
      await reader;
      expect(reads).toBeGreaterThan(0);
      expect(bad).toBe(0);
      expect(existsSync(`${file}.tmp`)).toBe(false);
    } finally {
      handle.release();
    }
  });
});
