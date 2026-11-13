// The float primitives and text helpers against the real Go implementations: fused multiply-add,
// math.Log, BM25 tokenizing and token estimation.
import { describe, expect, test } from "bun:test";
import { estimateTokens } from "../../src/search/chunker.ts";
import { fma } from "../../src/search/fma.ts";
import { goLog } from "../../src/search/golog.ts";
import { bm25Tokenize } from "../../src/search/lexical.ts";
import { askGo, hasSearchHelper } from "./search-helper.ts";

const suite = hasSearchHelper() ? describe : describe.skip;

const dv = new DataView(new ArrayBuffer(8));
const bits = (x: number) => {
  dv.setFloat64(0, x);
  return dv.getBigUint64(0).toString(16);
};

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("fma", () => {
  test("is a single-rounding multiply-add", () => {
    // 0.1 * 10 - 1 is 0 with two roundings and 2^-54 with one.
    expect(fma(0.1, 10, -1)).toBe(5.551115123125783e-17);
    expect(0.1 * 10 - 1).toBe(0);
    expect(fma(2, 3, 4)).toBe(10);
    expect(fma(0, 5, 3)).toBe(3);
    expect(Object.is(fma(-0, 5, -0), -0)).toBe(true);
  });
});

suite("against Go", () => {
  test("fma matches math.FMA", () => {
    const next = rng(11);
    const triples: [number, number, number][] = [];
    for (let i = 0; i < 400; i++) {
      const scale = (n: number) => (next() - 0.5) * 10 ** Math.floor(n * 6 - 3);
      triples.push([scale(next()), scale(next()), scale(next())]);
    }
    triples.push([0.1, 10, -1], [1e-300, 1e-300, 1], [3, 1 / 3, -1]);
    const expected = askGo(triples.map(([a, b, c]) => ({ op: "fma", a, b, c })));
    triples.forEach(([a, b, c], i) => {
      expect(bits(fma(a, b, c)), `fma(${a}, ${b}, ${c})`).toBe(expected[i] as string);
    });
  });

  test("goLog matches math.Log (the idf arguments and a random sweep)", () => {
    const xs: number[] = [];
    for (let n = 1; n <= 120; n++) {
      for (let df = 1; df <= n; df++) xs.push(1 + (n - df + 0.5) / (df + 0.5));
    }
    const next = rng(5);
    for (let i = 0; i < 1500; i++) xs.push(next() * 10 ** Math.floor(next() * 8 - 4));
    xs.push(1, 2, Math.E, 0.5, 1e-300, 5e-324, 1e300);
    const expected = askGo(xs.map((a) => ({ op: "log", a })));
    let bad = 0;
    xs.forEach((x, i) => {
      if (bits(goLog(x)) !== expected[i]) bad++;
    });
    expect(bad).toBe(0);
  });

  test("tokenize and estimate match", () => {
    const texts = [
      "",
      "Hello, World! It's 42 o'clock.",
      "Tiếng Việt có dấu: Phản hồi nhanh",
      "日本語のテキスト and mixed ünïcode İstanbul K",
      "snake_case-and-kebab.case/path/to/file.md",
      "  \t\n lots   of   space    ",
      "'s't're've'm'll'd contractions 'S 'T",
      "code ```fenced``` and `inline` {json: [1,2,3]}",
    ];
    const tok = askGo(texts.map((text) => ({ op: "tokenize", text })));
    const est = askGo(texts.map((text) => ({ op: "estimate", text })));
    texts.forEach((t, i) => {
      expect(bm25Tokenize(t), t).toEqual((tok[i] as string[] | null) ?? []);
      expect(estimateTokens(t), t).toBe(est[i] as number);
    });
  });
});
