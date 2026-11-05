// Go's error text from one module (src/platform/goerror.ts). The end-to-end parity of each call
// site is proven by the differential suites (codegen, sync, search degrade); this pins the table
// itself on the platform it runs on.
import { expect, test } from "bun:test";
import {
  CONNECTION_REFUSED,
  goFsError,
  goFsMessage,
  goNotExistReason,
  goTransportError,
} from "../../src/platform/goerror.ts";

const win = process.platform === "win32";
const err = (code: string, extra: Record<string, string> = {}) =>
  Object.assign(new Error(`node says ${code}`), { code, ...extra });

test("goFsError renders <op> <path>: <reason> with the platform's text", () => {
  expect(goFsError("open", "/x", err("ENOENT")).message).toBe(
    win
      ? "open /x: The system cannot find the file specified."
      : "open /x: no such file or directory",
  );
  expect(goFsError("lstat", "/x", err("ENOENT")).message).toBe(
    win
      ? "GetFileAttributesEx /x: The system cannot find the file specified."
      : "lstat /x: no such file or directory",
  );
  expect(goFsError("mkdir", "/x", err("ENOENT")).message).toBe(
    win
      ? "mkdir /x: The system cannot find the path specified."
      : "mkdir /x: no such file or directory",
  );
  expect(goFsError("open", "/x", err("EISDIR")).message).toBe("open /x: is a directory");
  // Unknown codes keep Node's message rather than inventing Go text.
  expect(goFsError("open", "/x", err("EWHATEVER")).message).toBe("open /x: node says EWHATEVER");
});

test("goFsMessage uses the error's own syscall and path", () => {
  expect(goFsMessage(err("ENOENT", { syscall: "open", path: "/a" }))).toBe(
    "open /a: no such file or directory",
  );
  expect(goFsMessage(err("EEXIST", { syscall: "open", path: "/d" }))).toBe(
    win ? "open /d: is a directory" : "open /d: file exists",
  );
  expect(goFsMessage(err("ENOENT"))).toBe("node says ENOENT");
});

test("goNotExistReason distinguishes a missing file from a missing parent on Windows", () => {
  expect(goNotExistReason(true)).toBe(
    win ? "The system cannot find the file specified." : "no such file or directory",
  );
  expect(goNotExistReason(false)).toBe(
    win ? "The system cannot find the path specified." : "no such file or directory",
  );
});

test("goTransportError renders a refused dial like net/http", async () => {
  // A port nothing listens on: the real fetch error, not a hand-made one.
  let caught: unknown;
  try {
    await fetch("http://127.0.0.1:9/api", { method: "POST" });
  } catch (e) {
    caught = e;
  }
  expect(goTransportError("POST", "http://127.0.0.1:9/api", caught)).toBe(
    `Post "http://127.0.0.1:9/api": dial tcp 127.0.0.1:9: ${CONNECTION_REFUSED}`,
  );
});
