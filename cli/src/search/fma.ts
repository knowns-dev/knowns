// Float parity with Go. The Go compiler fuses `x*y + z` into one fused multiply-add on arm64
// (and ppc64/s390x) and never does on amd64, so the low bits of BM25 and fusion scores depend on
// the platform the Go binary was built for. To keep scores identical to the Go binary running on
// the same machine, the sites where Go can fuse call `mulAdd`, which fuses exactly where Go does:
// on arm64 hosts. `KNOWNS_SEARCH_FMA=0|1` overrides the host default (used by tests).

let fused = process.arch === "arm64";
const override = process.env.KNOWNS_SEARCH_FMA;
if (override === "1") fused = true;
else if (override === "0") fused = false;

export function setFusedMultiplyAdd(enabled: boolean): void {
  fused = enabled;
}

export function fusedMultiplyAddEnabled(): boolean {
  return fused;
}

const view = new DataView(new ArrayBuffer(8));

/** value = mantissa * 2^exponent exactly, for a finite non-zero double. */
function decompose(x: number): { mant: bigint; exp: number } {
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const sign = bits >> 63n ? -1n : 1n;
  const e = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & 0xfffffffffffffn;
  if (e === 0) return { mant: sign * frac, exp: -1074 };
  return { mant: sign * (frac | (1n << 52n)), exp: e - 1075 };
}

function pow2(k: number): number {
  // k within [-1074, 1023] is representable; larger spans are applied in two steps by the caller.
  return 2 ** k;
}

/** IEEE-754 fused multiply-add: a*b+c with a single rounding. */
export function fma(a: number, b: number, c: number): number {
  const p = a * b;
  if (!Number.isFinite(p) || !Number.isFinite(c) || a === 0 || b === 0 || c === 0) return p + c;
  const x = decompose(a);
  const y = decompose(b);
  const z = decompose(c);
  const pm = x.mant * y.mant;
  const pe = x.exp + y.exp;
  const e = Math.min(pe, z.exp);
  const sum = (pm << BigInt(pe - e)) + (z.mant << BigInt(z.exp - e));
  if (sum === 0n) return 0;
  const neg = sum < 0n;
  const mag = neg ? -sum : sum;
  const bitLen = mag.toString(2).length;
  let q = mag;
  let shift = 0;
  if (bitLen > 53) {
    shift = bitLen - 53;
    q = mag >> BigInt(shift);
    const rem = mag & ((1n << BigInt(shift)) - 1n);
    const half = 1n << BigInt(shift - 1);
    if (rem > half || (rem === half && (q & 1n) === 1n)) q += 1n;
  }
  const exp = e + shift;
  let r = Number(q);
  // Apply the exponent in two halves so neither factor over- or underflows on its own.
  const h = Math.trunc(exp / 2);
  r = r * pow2(h) * pow2(exp - h);
  return neg ? -r : r;
}

/** a*b + c, fused when the host Go build would fuse it. */
export function mulAdd(a: number, b: number, c: number): number {
  return fused ? fma(a, b, c) : a * b + c;
}
