// Deterministic argument set for math.Log parity: the BM25 idf arguments plus edge cases (subnormals,
// exact and neighbouring powers of two, 1 and its neighbours, sqrt(2)/2 and its neighbours where the
// amd64 assembly and the pure-Go code differ, huge values, negatives, +-0, infinities) and random
// bit patterns. Entries are IEEE-754 bit patterns so -0, NaN and subnormals survive any transport.
const dv = new DataView(new ArrayBuffer(8));

export const toBits = (x: number): bigint => {
  dv.setFloat64(0, x);
  return dv.getBigUint64(0);
};
export const fromBits = (b: bigint): number => {
  dv.setBigUint64(0, b);
  return dv.getFloat64(0);
};
export const hex = (x: number): string => toBits(x).toString(16);

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function logSamples(): number[] {
  const out: number[] = [];
  const add = (x: number) => out.push(x);
  const neighbours = (x: number, n = 3) => {
    const b = toBits(x);
    for (let d = -n; d <= n; d++) add(fromBits(b + BigInt(d)));
  };
  // BM25 idf arguments: 1 + (N - df + 0.5) / (df + 0.5)
  for (let n = 1; n <= 150; n++)
    for (let df = 1; df <= n; df++) add(1 + (n - df + 0.5) / (df + 0.5));
  // powers of two and their neighbours (all exponents, including the subnormal range)
  for (let e = -1074; e <= 1023; e++) {
    const p = e < -1022 ? 2 ** -1074 * 2 ** (e + 1074) : 2 ** e;
    neighbours(p, 1);
  }
  neighbours(1, 40);
  neighbours(0.5, 3);
  neighbours(2, 3);
  neighbours(Math.SQRT2 / 2, 8); // the f1 <= sqrt(2)/2 boundary of the assembly
  neighbours(Math.SQRT2, 8);
  neighbours(Math.E, 3);
  neighbours(10, 3);
  for (const x of [
    0.5 * Math.SQRT2,
    (2 * Math.SQRT2) / 2,
    4 * (Math.SQRT2 / 2),
    Math.SQRT2 / 2 / 2 ** 20,
  ])
    neighbours(x, 4);
  // subnormals: smallest, largest, assorted mantissas
  neighbours(5e-324, 4);
  neighbours(2.2250738585072009e-308, 4); // largest subnormal
  neighbours(2.2250738585072014e-308, 4); // smallest normal
  for (let i = 0; i < 300; i++) add(fromBits(BigInt(i) * 0x0123456789abn + 1n));
  // huge and tiny
  neighbours(Number.MAX_VALUE, 3);
  add(1e300);
  add(1e-300);
  // special values
  add(0);
  add(-0);
  add(-1);
  add(-5e-324);
  add(-Number.MAX_VALUE);
  add(Number.POSITIVE_INFINITY);
  add(Number.NEGATIVE_INFINITY);
  add(Number.NaN);
  // random: log-uniform magnitudes, near 1, and raw random bit patterns (positive finite only)
  const next = rng(20261104);
  for (let i = 0; i < 6000; i++) add(next() * 10 ** Math.floor(next() * 40 - 20));
  for (let i = 0; i < 3000; i++) add(1 + (next() - 0.5) * 10 ** -Math.floor(next() * 14));
  for (let i = 0; i < 4000; i++) {
    const hi = BigInt(Math.floor(next() * 0x7ff00000));
    const lo = BigInt(Math.floor(next() * 0x100000000));
    add(fromBits((hi << 32n) | lo));
  }
  return out;
}
