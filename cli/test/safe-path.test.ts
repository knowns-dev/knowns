// AC-3: safe path checks reject the same escapes as Go (internal/safepath/path_test.go), including
// symlink escapes and case variants, and agree with the real Go implementation on a wide corpus.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { canonicalPath } from "../src/storage/core/canonical-path.ts";
import {
  resolveProject,
  resolveProjectReal,
  resolveSafe,
  SafePathError,
} from "../src/storage/core/safe-path.ts";
import { hasGoHelper, runHelper, tempDir } from "./helpers/go-helper.ts";

const isWindows = process.platform === "win32";
let base: string;
let root: string;
let outside: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "knowns-safepath-")));
  root = join(base, "Root");
  outside = join(base, "outside");
  mkdirSync(join(root, "guides"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.md"), "x");
  try {
    symlinkSync(outside, join(root, "linked"), "dir");
    symlinkSync(join(outside, "secret.md"), join(root, "secret-link.md"));
    symlinkSync(join(root, "guides"), join(root, "inner-link"), "dir");
  } catch {
    // symlinks unavailable (unprivileged Windows): the symlink tests below skip themselves
  }
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const hasSymlinks = () => {
  try {
    return realpathSync(join(root, "linked")) === outside;
  } catch {
    return false;
  }
};

describe("ported from path_test.go", () => {
  test("rejects traversal and platform alternate paths", () => {
    for (const path of [
      "../outside",
      "..\\outside",
      join(dirname(root), "outside"),
      "C:\\outside",
      "\\\\server\\share\\outside",
      "\\\\?\\C:\\outside",
    ]) {
      expect(() => resolveSafe(root, path), path).toThrow(SafePathError);
    }
  });

  test("allows a contained path and rejects a symlink escape", () => {
    expect(resolveSafe(root, "guides/setup.md")).toBe(join(root, "guides", "setup.md"));
    if (!hasSymlinks()) return;
    expect(() => resolveSafe(root, "linked/escape.md")).toThrow(/escapes root through a symlink/);
  });

  test("resolveProject allows only a contained absolute path", () => {
    const inside = join(root, "main.go");
    expect(resolveProject(root, inside)).toBe(inside);
    expect(() => resolveProject(root, join(dirname(root), "outside.go"))).toThrow(
      /path escapes allowed root/,
    );
  });
});

describe("rejections", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["", "", /path is required/],
    ["   ", "", /path is required/],
    ["a\0b", "", /NUL byte/],
    ["//?/C:/x", "", /Windows device prefix/],
    ["\\\\.\\pipe\\x", "", /Windows device prefix/],
    ["/etc/passwd", "", /path must be relative/],
    ["C:/x", "", /volume or UNC prefix/],
    ["//server/share/x", "", /device prefix|volume or UNC prefix|must be relative/],
    ["a/../../b", "", /parent traversal/],
    ["..", "", /parent traversal/],
    ["a/..", "", /parent traversal/],
  ];
  test.each(cases)("resolveSafe(%p)", (path, _x, message) => {
    expect(() => resolveSafe(root, path)).toThrow(message);
  });

  test("an empty or whitespace path is reported before anything else", () => {
    expect(() => resolveProject(root, " ")).toThrow("path is required");
  });

  test("a symlink to a file outside root is an escape", () => {
    if (!hasSymlinks()) return;
    expect(() => resolveSafe(root, "secret-link.md")).toThrow(/escapes root through a symlink/);
  });

  test("a symlink that stays inside root is allowed, and real resolution follows it", () => {
    if (!hasSymlinks()) return;
    expect(resolveSafe(root, "inner-link/new.md")).toBe(join(root, "inner-link", "new.md"));
    expect(resolveProjectReal(root, "inner-link/new.md")).toBe(join(root, "guides", "new.md"));
  });

  test("a not-yet-existing path under a symlinked directory is resolved through the link", () => {
    if (!hasSymlinks()) return;
    expect(() => resolveSafe(root, "linked/does/not/exist.md")).toThrow(/escapes root/);
  });
});

describe("case variants", () => {
  const variant = (p: string) => {
    const name = p.split(sep).pop() ?? "";
    const swapped = [...name]
      .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
      .join("");
    return p.slice(0, p.length - name.length) + swapped;
  };

  test("a differently cased spelling of the root is not 'inside' as an absolute path", () => {
    // Go compares path strings (filepath.Rel), so on a case-sensitive comparison "/x/rOOT/a" is not
    // within "/x/Root". Windows compares case-insensitively in both implementations.
    const alt = join(variant(root), "a.md");
    if (isWindows) {
      expect(resolveProject(root, alt)).toBeTruthy();
    } else {
      expect(() => resolveProject(root, alt)).toThrow(/path escapes allowed root/);
    }
  });

  test("a relative path is unaffected by case and stays inside", () => {
    expect(resolveSafe(variant(root), "A.md")).toBe(join(variant(root), "A.md"));
  });

  test("canonicalPath collapses case variants on a case-insensitive filesystem", () => {
    const alt = variant(root);
    let insensitive = false;
    try {
      insensitive = realpathSync(alt) !== undefined;
    } catch {
      insensitive = false;
    }
    if (insensitive) expect(canonicalPath(alt)).toBe(root);
    else expect(canonicalPath(alt)).toBe(alt);
  });

  test("canonicalPath keeps missing components as spelled", () => {
    const missing = join(root, "Not-There", "Deeper");
    expect(canonicalPath(missing)).toBe(missing);
    expect(canonicalPath("")).toBe("");
  });

  test("canonicalPath leaves an existing exact spelling unchanged", () => {
    expect(canonicalPath(join(root, "guides"))).toBe(join(root, "guides"));
  });
});

describe("parity with the real Go safepath.Resolve*", () => {
  const home = tempDir("knowns-ts-home-");
  const corpus = [
    "guides/setup.md",
    "guides",
    "new/dir/file.md",
    "./guides/../guides/x.md".replace("../", ""),
    "../outside",
    "..\\outside",
    "a/../../b",
    "/etc/passwd",
    "C:\\outside",
    "C:/x",
    "\\\\server\\share\\x",
    "\\\\?\\C:\\x",
    "//?/C:/x",
    "a\\b\\c.md",
    "linked/escape.md",
    "linked",
    "secret-link.md",
    "inner-link/new.md",
    "linked/does/not/exist.md",
    " ",
    "",
    "trailing/",
    "dot/./segments/./x",
    "ünïcode/файл.md",
    "name:with:colons.md",
  ];

  const tsResult = (mode: "resolve" | "project" | "real", path: string): string => {
    try {
      const fn =
        mode === "resolve" ? resolveSafe : mode === "project" ? resolveProject : resolveProjectReal;
      return `OK ${fn(root, path)}`;
    } catch (e) {
      return `ERR ${(e as Error).message}`;
    }
  };

  const goResult = (mode: string, path: string): string => {
    const lines = runHelper(["safepath", mode, root, path], home);
    return lines[0] ?? "";
  };

  const extra = () => [
    join(root, "main.go"),
    join(root, "guides", "x.md"),
    join(dirname(root), "outside.go"),
    join(variantOf(root), "a.md"),
    join(root, "linked", "x"),
  ];
  function variantOf(p: string) {
    const name = p.split(sep).pop() ?? "";
    return p.slice(0, p.length - name.length) + name.toUpperCase().replace("ROOT", "rOOT");
  }

  for (const mode of ["resolve", "project", "real"] as const) {
    test.skipIf(!hasGoHelper())(
      `${mode}: same verdict and result for ${corpus.length}+ paths`,
      () => {
        for (const path of [...corpus, ...extra()]) {
          const ts = tsResult(mode, path);
          const go = goResult(mode, path);
          const [tsStatus, ...tsRest] = ts.split(" ");
          const [goStatus, ...goRest] = go.split(" ");
          expect(tsStatus, `${mode} ${JSON.stringify(path)}\n ts: ${ts}\n go: ${go}`).toBe(
            goStatus,
          );
          if (goStatus === "OK") {
            expect(tsRest.join(" "), `${mode} ${JSON.stringify(path)}`).toBe(goRest.join(" "));
          } else if (goRest.join(" ").startsWith("path escapes root through a symlink")) {
            expect(tsRest.join(" ")).toStartWith("path escapes root through a symlink");
          } else {
            expect(tsRest.join(" "), `${mode} ${JSON.stringify(path)}`).toBe(goRest.join(" "));
          }
        }
      },
    );
  }

  test.skipIf(!hasGoHelper())("canonicalPath agrees with util.CanonicalPath", () => {
    for (const p of [
      root,
      join(root, "guides"),
      join(root, "Nope", "x"),
      join(variantOf(root), "guides"),
    ]) {
      expect(canonicalPath(p), p).toBe(runHelper(["canonical", p], home)[0] ?? "");
    }
  });
});
