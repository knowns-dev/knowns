import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { windowsCompileOptions, windowsFileVersion } from "../../scripts/lib.ts";

describe("windows executable metadata", () => {
  test("file version is four numeric fields", () => {
    expect(windowsFileVersion("0.35.0")).toBe("0.35.0.0");
    expect(windowsFileVersion("1.2.3-rc.1")).toBe("1.2.3.0");
    expect(windowsFileVersion("v1")).toBe("0.0.0.0");
    expect(windowsFileVersion("dev")).toBe("0.0.0.0");
  });

  test("only a Windows host passes options, because Bun ignores them elsewhere", () => {
    expect(windowsCompileOptions("0.35.0", "darwin")).toBeUndefined();
    expect(windowsCompileOptions("0.35.0", "linux")).toBeUndefined();
    const o = windowsCompileOptions("0.35.0", "win32");
    expect(o?.title).toBe("Knowns");
    expect(o?.description).toBe("Knowns");
    expect(o?.version).toBe("0.35.0.0");
  });

  test("the icon is a real multi-size .ico", () => {
    const icon = windowsCompileOptions("0.35.0", "win32")?.icon ?? "";
    expect(existsSync(icon)).toBe(true);
    const b = readFileSync(icon);
    expect(b.readUInt16LE(0)).toBe(0); // reserved
    expect(b.readUInt16LE(2)).toBe(1); // type: icon
    const sizes = new Set<number>();
    for (let i = 0; i < b.readUInt16LE(4); i++) sizes.add(b[6 + i * 16] || 256);
    for (const s of [16, 32, 48, 256]) expect(sizes.has(s)).toBe(true);
    expect(icon).toBe(join(import.meta.dir, "../../scripts/assets/knowns.ico"));
  });
});
