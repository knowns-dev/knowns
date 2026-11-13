// math.Log parity per target. Go computes math.Log with different code on arm64 (pure Go, fused
// multiply-adds) and amd64 (log_amd64.s, no fusion), and the two differ in the last bit for about
// 2% of the arguments, so the TS port carries both and picks by the machine it runs on.
// The fixtures hold Go's own answers for every logSamples() argument, captured with
// test/search/golog-capture.ts from a helper built for each target (darwin/arm64 natively,
// windows/amd64 on a real amd64 PC, Go 1.26). Each implementation is checked against its fixture
// on whatever host runs the tests, so both paths are proven everywhere; a live Go helper, when
// available, then checks the host's own selection.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { fusedMultiplyAddEnabled, setFusedMultiplyAdd } from "../../src/search/fma.ts";
import { goLog, goLogAmd64, goLogPure, hostLogImplementation } from "../../src/search/golog.ts";
import { hex, logSamples } from "./golog-samples.ts";
import { askGo, hasSearchHelper } from "./search-helper.ts";

const load = (name: string): string[] =>
  gunzipSync(readFileSync(join(import.meta.dir, "fixtures", "golog", name)))
    .toString()
    .trimEnd()
    .split("\n");

const samples = logSamples();
const arm64 = load("log-arm64.txt.gz");
const amd64 = load("log-amd64.txt.gz");

/** Mismatching sample indexes of `fn` against Go's answers (NaN compared as "nan"). */
function mismatches(fn: (x: number) => number, expected: string[]): string[] {
  const bad: string[] = [];
  samples.forEach((x, i) => {
    const want = expected[i] as string;
    const got = fn(x);
    if (want === "special") return;
    const gotHex = Number.isNaN(got) ? "nan" : hex(got);
    if (gotHex !== want) bad.push(`log(${hex(x)}) = ${gotHex}, Go ${want}`);
  });
  return bad;
}

describe("fixtures", () => {
  test("cover every sample and the two Go targets really differ", () => {
    expect(arm64.length).toBe(samples.length);
    expect(amd64.length).toBe(samples.length);
    const differing = samples.filter((_, i) => arm64[i] !== amd64[i]).length;
    expect(differing).toBeGreaterThan(100);
  });
});

describe("amd64 assembly port (log_amd64.s)", () => {
  test("matches Go amd64 bit for bit on all samples", () => {
    const bad = mismatches(goLogAmd64, amd64);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test("special values", () => {
    expect(goLogAmd64(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(goLogAmd64(-0)).toBe(Number.NEGATIVE_INFINITY);
    expect(goLogAmd64(-1)).toBeNaN();
    expect(goLogAmd64(Number.NEGATIVE_INFINITY)).toBeNaN();
    expect(goLogAmd64(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(goLogAmd64(Number.NaN)).toBeNaN();
    expect(goLogAmd64(1)).toBe(0);
  });

  test("reproduces the assembly's subnormal behaviour", () => {
    // Go's amd64 Log(5e-324) is not the true logarithm (the assembly does not normalize subnormals).
    expect(hex(goLogAmd64(5e-324))).toBe(amd64[samples.findIndex((x) => x === 5e-324)] as string);
    expect(goLogAmd64(5e-324)).not.toBeCloseTo(Math.log(5e-324), 3);
  });
});

describe("pure-Go port (arm64, fused)", () => {
  const was = fusedMultiplyAddEnabled();
  beforeAll(() => setFusedMultiplyAdd(true));
  afterAll(() => setFusedMultiplyAdd(was));

  test("matches Go arm64 bit for bit on all samples", () => {
    // The pure-Go port covers finite positive arguments; zero, negative and non-finite are the
    // special-case prologue and are compared too.
    const bad = mismatches(goLogPure, arm64);
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

describe("selection follows the machine", () => {
  test("x64 uses the assembly port, everything else the pure-Go one", () => {
    expect(hostLogImplementation).toBe(process.arch === "x64" ? "amd64-asm" : "pure-go");
    expect(goLog).toBe(process.arch === "x64" ? goLogAmd64 : goLogPure);
  });

  test("fusion is on exactly on arm64 (unless KNOWNS_SEARCH_FMA overrides)", () => {
    if (process.env.KNOWNS_SEARCH_FMA === undefined) {
      expect(fusedMultiplyAddEnabled()).toBe(process.arch === "arm64");
    }
  });
});

const live = hasSearchHelper() ? describe : describe.skip;
live("host selection against a live Go helper built for this machine", () => {
  test("goLog equals math.Log on every sample", () => {
    const finite = samples.filter((x) => Number.isFinite(x));
    const got = askGo(finite.map((a) => ({ op: "log", a })));
    let bad = 0;
    finite.forEach((x, i) => {
      const want = got[i] as string;
      const r = goLog(x);
      const rh = Number.isNaN(r) ? "nan" : hex(r);
      const wantNaN =
        (BigInt(`0x${want}`) & 0x7ff0000000000000n) === 0x7ff0000000000000n &&
        (BigInt(`0x${want}`) & 0xfffffffffffffn) !== 0n;
      if (rh !== (wantNaN ? "nan" : want)) bad++;
    });
    expect(bad).toBe(0);
  });
});
