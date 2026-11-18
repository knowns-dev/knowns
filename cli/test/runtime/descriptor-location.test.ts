import { describe, expect, test } from "bun:test";
import { checkDescriptorLocation } from "../../src/runtime/mcp-endpoint.ts";

// The production rule for where a Windows token file may live, with the machine faked: it runs on
// every OS. (UiHost and the MCP endpoint skip it entirely when the caller names the root.)
const win = { windows: true, home: "C:\\Users\\Admin" };

describe("checkDescriptorLocation", () => {
  test("a root under the profile is fine, in any case", () => {
    expect(() =>
      checkDescriptorLocation("C:\\Users\\Admin\\.knowns\\runtime", { ...win, env: {} }),
    ).not.toThrow();
    expect(() =>
      checkDescriptorLocation("c:\\users\\ADMIN\\.knowns\\runtime", { ...win, env: {} }),
    ).not.toThrow();
  });

  test("a root outside the profile, or on another drive, is refused", () => {
    for (const root of [
      "C:\\Windows\\Temp\\knowns-ui-x",
      "C:\\Users\\Admin2\\x",
      "D:\\Users\\Admin\\x",
    ]) {
      expect(() => checkDescriptorLocation(root, { ...win, env: {} })).toThrow(
        /outside the user profile/,
      );
    }
  });

  test("HOME on another drive is a legitimate profile: globalRootPath puts ~/.knowns under it", () => {
    const env = { HOME: "D:\\home\\admin" };
    expect(() =>
      checkDescriptorLocation("D:\\home\\admin\\.knowns\\runtime", { ...win, env }),
    ).not.toThrow();
    expect(() => checkDescriptorLocation("E:\\other", { ...win, env })).toThrow();
  });

  test("a root named with KNOWNS_RUNTIME_ROOT is the user's choice, on any drive", () => {
    const env = { KNOWNS_RUNTIME_ROOT: "E:\\rt" };
    expect(() => checkDescriptorLocation("E:\\rt", { ...win, env })).not.toThrow();
  });

  test("not checked off Windows", () => {
    expect(() => checkDescriptorLocation("/tmp/x", { windows: false, env: {} })).not.toThrow();
  });
});
