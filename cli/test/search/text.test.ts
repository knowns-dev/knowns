import { describe, expect, test } from "bun:test";
import {
  byteSlicePrefix,
  compareStrings,
  goFields,
  goToLower,
  goTrimSpace,
  truncateStr,
} from "../../src/search/text.ts";
import { formatRFC3339NanoUTC, goTimeString, timePtr } from "../../src/search/time.ts";

describe("Go string semantics", () => {
  test("TrimSpace and Fields use unicode.IsSpace, not JS whitespace", () => {
    expect(goTrimSpace("\u0085 x   ")).toBe("x");
    expect(goTrimSpace("﻿x")).toBe("﻿x"); // Go does not trim a BOM; JS trim() does
    expect(goFields(" a b\tc\n d ")).toEqual(["a", "b", "c", "d"]);
  });

  test("ToLower is one rune to one rune", () => {
    expect(goToLower("ÀBİ")).toBe("àbi");
  });

  test("truncateStr counts bytes and writes U+FFFD for a cut sequence", () => {
    expect(truncateStr("abcdef", 10)).toBe("abcdef");
    expect(truncateStr("abcdefghij", 8)).toBe("abcde...");
    // "é" is two bytes: cutting after the lead byte leaves one orphan.
    expect(byteSlicePrefix("aé", 2)).toBe("a\ufffd");
    // a 3-byte rune cut after two bytes leaves two orphans, as encoding/json writes them
    expect(byteSlicePrefix("a日", 3)).toBe("a\ufffd\ufffd");
    expect(byteSlicePrefix("a日", 4)).toBe("a日");
    expect(truncateStr("日本語日本語日本語", 10)).toBe("日本\ufffd...");
  });

  test("strings compare in code point (UTF-8) order", () => {
    expect(compareStrings("a", "b")).toBe(-1);
    expect(compareStrings("￿", "\u{10000}")).toBe(-1); // UTF-16 order says the opposite
    expect(compareStrings("abc", "ab")).toBe(1);
    expect(compareStrings("x", "x")).toBe(0);
  });
});

describe("Go time formatting", () => {
  test("trailing fractional zeros are dropped and a zero offset is Z", () => {
    expect(goTimeString("2026-11-03T13:37:35.500Z")).toBe("2026-11-03T13:37:35.5Z");
    expect(goTimeString("2026-11-03T13:37:35.000Z")).toBe("2026-11-03T13:37:35Z");
    expect(goTimeString("2026-11-03T13:37:35+00:00")).toBe("2026-11-03T13:37:35Z");
    expect(goTimeString("2026-11-03T13:37:35.25+07:00")).toBe("2026-11-03T13:37:35.25+07:00");
  });

  test("the zero time is not a time", () => {
    expect(timePtr("0001-01-01T00:00:00Z")).toBeUndefined();
    expect(timePtr(undefined)).toBeUndefined();
    expect(timePtr("2026-11-03T13:37:35.549Z")).toBe("2026-11-03T13:37:35.549Z");
  });

  test("RFC3339Nano in UTC", () => {
    expect(formatRFC3339NanoUTC("2026-11-03T20:37:35.5+07:00")).toBe("2026-11-03T13:37:35.5Z");
    expect(formatRFC3339NanoUTC("2026-11-03T13:37:35.123456789Z")).toBe(
      "2026-11-03T13:37:35.123456789Z",
    );
  });
});
