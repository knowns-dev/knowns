// `knowns update` installs knowns and knowns-proxy as one unit: a locked .old is not an error, a
// failed required swap puts the others back, and a proxy that cannot be replaced only warns. The
// Windows path is driven on every OS through the rename/remove seams.
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  removeStaleProxy,
  replaceBinaries,
  sweepOldBinaries,
} from "../../../src/cli/commands/update.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(goos: "windows" | "linux") {
  const dir = mkdtempSync(join(tmpdir(), "knowns-update-unit-"));
  dirs.push(dir);
  const ext = goos === "windows" ? ".exe" : "";
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const files = {
    knowns: join(bin, `knowns${ext}`),
    proxy: join(bin, `knowns-proxy${ext}`),
  };
  writeFileSync(files.knowns, "OLD-K");
  writeFileSync(files.proxy, "OLD-P");
  writeFileSync(join(dir, "k"), "NEW-K");
  writeFileSync(join(dir, "p"), "NEW-P");
  const items = [
    { src: join(dir, "p"), dest: files.proxy, optional: true },
    { src: join(dir, "k"), dest: files.knowns },
  ];
  return { dir, bin, files, items };
}
const read = (p: string) => readFileSync(p, "utf8");

describe("replaceBinaries", () => {
  for (const goos of ["windows", "linux"] as const) {
    test(`${goos}: both binaries are replaced and nothing is left behind but the Windows .old`, () => {
      const { bin, files, items } = setup(goos);
      replaceBinaries(items, goos);
      expect(read(files.knowns)).toBe("NEW-K");
      expect(read(files.proxy)).toBe("NEW-P");
      const left = readdirSync(bin).filter((n) => /\.(tmp|rollback)$/.test(n));
      expect(left).toEqual([]);
      if (goos === "windows") expect(read(`${files.knowns}.old`)).toBe("OLD-K");
    });
  }

  test("a locked .old from a previous update is tolerated with a unique name", () => {
    const { files, items } = setup("windows");
    writeFileSync(`${files.knowns}.old`, "STILL-RUNNING");
    const locked = (p: string) => {
      if (p === `${files.knowns}.old` || p === `${files.proxy}.old`)
        throw new Error("EPERM: locked");
      rmSync(p, { force: true });
    };
    replaceBinaries(items, "windows", { remove: locked });
    expect(read(files.knowns)).toBe("NEW-K");
    expect(read(files.proxy)).toBe("NEW-P");
    expect(read(`${files.knowns}.old`)).toBe("STILL-RUNNING");
    const kept = readdirSync(join(files.knowns, "..")).filter((n) =>
      /knowns\.exe\.old\.\d+$/.test(n),
    );
    expect(kept.length).toBe(1);
    expect(read(join(files.knowns, "..", kept[0] as string))).toBe("OLD-K");
  });

  test("a failed knowns swap puts the already-swapped proxy back (no new proxy with old knowns)", () => {
    for (const goos of ["windows", "linux"] as const) {
      const { bin, files, items } = setup(goos);
      const failing = (from: string, to: string) => {
        if (from === `${files.knowns}.tmp` && to === files.knowns) throw new Error("EPERM: in use");
        renameSync(from, to);
      };
      expect(() => replaceBinaries(items, goos, { rename: failing })).toThrow("EPERM: in use");
      expect(read(files.knowns)).toBe("OLD-K");
      expect(read(files.proxy)).toBe("OLD-P");
      expect(readdirSync(bin).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    }
  });

  test("a proxy that cannot be replaced is a warning and keeps the old proxy", () => {
    for (const goos of ["windows", "linux"] as const) {
      const { files, items } = setup(goos);
      const failing = (from: string, to: string) => {
        if (to === files.proxy && from.endsWith(".tmp")) throw new Error("EPERM: proxy in use");
        renameSync(from, to);
      };
      const warnings: string[] = [];
      replaceBinaries(items, goos, { rename: failing, warn: (m) => warnings.push(m) });
      expect(read(files.knowns)).toBe("NEW-K");
      expect(read(files.proxy)).toBe("OLD-P");
      expect(warnings.join("\n")).toContain("knowns-proxy");
      expect(existsSync(`${files.proxy}.tmp`)).toBe(false);
    }
  });

  test("removeStaleProxy deletes the previous proxy, or moves a locked one aside", () => {
    const { bin, files } = setup("linux");
    expect(removeStaleProxy(bin, "linux")).toBe(true);
    expect(existsSync(files.proxy)).toBe(false);
    expect(removeStaleProxy(bin, "linux")).toBe(false);
    expect(existsSync(files.knowns)).toBe(true);
  });

  test("sweepOldBinaries removes previous .old files and leaves the binaries", () => {
    const { bin, files } = setup("windows");
    for (const n of ["knowns.exe.old", "knowns.exe.old.1731000000000", "knowns-proxy.exe.old"]) {
      writeFileSync(join(bin, n), "x");
    }
    expect(sweepOldBinaries(bin)).toBe(3);
    expect(readdirSync(bin).sort()).toEqual(["knowns-proxy.exe", "knowns.exe"]);
    expect(read(files.knowns)).toBe("OLD-K");
  });
});
