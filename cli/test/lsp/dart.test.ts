import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverDartProject, parseDartSDKVersion } from "../../src/lsp/dart.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "lsp-dart-"));
}

test("parseDartSDKVersion", () => {
  expect(parseDartSDKVersion("Dart SDK version: 3.4.0 (stable) on macos")).toBe("3.4.0");
  expect(parseDartSDKVersion("3.1.2,")).toBe("3.1.2");
  expect(parseDartSDKVersion("  ")).toBe("");
});

test("discoverDartProject prefers pubspec, falls back to root", () => {
  const root = tmp();
  expect(discoverDartProject(root)).toEqual({ path: "", kind: "" });
  mkdirSync(join(root, "lib"));
  writeFileSync(join(root, "lib", "a.dart"), "");
  expect(discoverDartProject(root)).toEqual({ path: root, kind: "root" });
  writeFileSync(join(root, "analysis_options.yaml"), "");
  expect(discoverDartProject(root).kind).toBe("analysis_options");
  writeFileSync(join(root, "pubspec.yaml"), "");
  expect(discoverDartProject(root)).toEqual({ path: root, kind: "pubspec" });
});

test("discoverDartProject skips .dart_tool and empty root", () => {
  const root = tmp();
  mkdirSync(join(root, ".dart_tool"));
  writeFileSync(join(root, ".dart_tool", "x.dart"), "");
  expect(discoverDartProject(root).path).toBe("");
  expect(discoverDartProject("")).toEqual({ path: "", kind: "" });
});
