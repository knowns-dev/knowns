// `knowns doc hard-delete` (TSR-N5EFM6). A normal Doc is purged exactly as 0.34.1 does it. A
// legacy Doc without a stable `id:` cannot be purged: Go 0.34.1 still printed "Permanently deleted
// doc" with exit 0 and left the file (and a doc-empty.lock behind). The TS build refuses it before
// touching anything, with exit 1 and an error naming the Doc. That is a deliberate divergence,
// decided by the user on 2026-11-06.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasGoBin } from "../oracle.ts";
import {
  goInTemplate,
  makeSandbox,
  runGoIn,
  runTsIn,
  type Sandbox,
  sandboxEnv,
} from "./subprocess-diff.ts";

const t = test.skipIf(!hasGoBin);
const ENTRY = join(import.meta.dir, "..", "..", "..", "src", "bin.ts");
let box: Sandbox;

beforeAll(() => {
  if (!hasGoBin) return;
  box = makeSandbox("knowns-dochd-");
  mkdirSync(box.home, { recursive: true });
  mkdirSync(box.proj, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: box.proj });
  goInTemplate(box, ["init", "dochd", "--no-wizard"]);
  goInTemplate(box, ["doc", "create", "normal-doc", "-c", "has an id"]);
  goInTemplate(box, ["doc", "create", "legacy-doc", "-c", "written before docs had ids"]);
  goInTemplate(box, ["doc", "create", "guide", "-f", "guides", "-c", "nested"]);
  const legacy = join(box.proj, ".knowns", "docs", "legacy-doc.md");
  writeFileSync(legacy, readFileSync(legacy, "utf8").replace(/^id: .*\n/m, ""));
}, 60_000);

afterAll(() => {
  if (box) rmSync(box.root, { recursive: true, force: true });
});

const hardDelete = (path: string) => [
  "doc",
  "hard-delete",
  path,
  "--allow-hard-delete",
  "--yes",
  "--reason",
  "cleanup",
];

const WATCH = ["proj/.knowns/docs", "proj/.knowns/history", "proj/.knowns/tombstones"];

// Wall-clock fields only: timestamps, batch ids and lifecycle event ids.
const mask = (s: string) =>
  s
    .replace(/"batchId": ?"batch-[0-9a-f]+"/g, '"batchId":"<b>"')
    .replace(/"(\w+At)": ?"[^"]+"/g, '"$1":"<t>"')
    .replace(/:hard_delete:\d+:[0-9a-f]+/g, ":hard_delete:<t>");

describe("doc hard-delete", () => {
  for (const path of ["normal-doc", "guides/guide"]) {
    t(`${path}: matches 0.34.1 (output, exit and files)`, async () => {
      const go = await runGoIn(box, hardDelete(path), { watch: WATCH });
      const ts = await runTsIn(box, hardDelete(path), { watch: WATCH });
      const masked = (o: typeof go) => ({
        ...o,
        files: Object.fromEntries(Object.entries(o.files).map(([k, v]) => [k, mask(v)])),
      });
      expect(masked(ts)).toEqual(masked(go));
      expect(ts.code).toBe(0);
      expect(ts.stdout).toBe(`Permanently deleted doc: ${path}\n`);
    });
  }

  t("a Doc without a stable id: refused, nothing changed (Go claims success)", async () => {
    const go = await runGoIn(box, hardDelete("legacy-doc"));
    expect(go.code).toBe(0);
    expect(go.stdout).toBe("Permanently deleted doc: legacy-doc\n");

    const run = mkdtempSync(join(tmpdir(), "knowns-dochd-run-"));
    try {
      cpSync(box.root, run, { recursive: true });
      const kn = join(run, "proj", ".knowns");
      const snapshot = () =>
        Bun.spawnSync(["find", ".", "-type", "f"], { cwd: kn })
          .stdout.toString()
          .split("\n")
          .sort();
      const before = snapshot();
      const p = Bun.spawnSync([process.execPath, ENTRY, ...hardDelete("legacy-doc")], {
        cwd: join(run, "proj"),
        env: sandboxEnv(join(run, "home"), { KNOWNS_RUNTIME_INLINE: "1" }),
      });
      expect(p.exitCode).toBe(1);
      expect(p.stdout.toString()).toBe("");
      expect(p.stderr.toString()).toStartWith(
        "Error: doc hard-delete: legacy-doc has no stable Doc id, so it cannot be hard-deleted; nothing was changed\n",
      );
      expect(existsSync(join(kn, "docs", "legacy-doc.md"))).toBe(true);
      // No tombstone, history, reservation or lock left behind.
      expect(snapshot()).toEqual(before);
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  });
});
