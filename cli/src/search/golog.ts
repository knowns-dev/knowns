// math.Log as Go computes it. V8's Math.log and Go's math.Log are both fdlibm descendants but
// differ in the last bit for about 7% of the arguments BM25's idf feeds them, which would shift
// scores by an ulp. This is Go's pure-Go `log` (FreeBSD e_log.c), with its multiply-adds fused
// where the Go arm64 compiler fuses them (see fma.ts).
import { mulAdd } from "./fma.ts";

const bits = new DataView(new ArrayBuffer(8));
/** The double with these high and low words (the constants' exact fdlibm bit patterns). */
function f64(hi: number, lo: number): number {
  bits.setUint32(0, hi);
  bits.setUint32(4, lo);
  return bits.getFloat64(0);
}

const LN2_HI = f64(0x3fe62e42, 0xfee00000);
const LN2_LO = f64(0x3dea39ef, 0x35793c76);
const L1 = f64(0x3fe55555, 0x55555593);
const L2 = f64(0x3fd99999, 0x9997fa04);
const L3 = f64(0x3fd24924, 0x94229359);
const L4 = f64(0x3fcc71c5, 0x1d8e78af);
const L5 = f64(0x3fc74664, 0x96cb03de);
const L6 = f64(0x3fc39a09, 0xd078c69f);
const L7 = f64(0x3fc2f112, 0xdf3e5244);
const SQRT2_OVER_2 = Math.SQRT2 / 2;

const view = new DataView(new ArrayBuffer(8));

/** math.Frexp for a finite positive x: x = frac * 2^exp with frac in [0.5, 1). */
function frexp(x: number): { frac: number; exp: number } {
  view.setFloat64(0, x);
  let hi = view.getUint32(0);
  let exp = 0;
  let value = x;
  if (((hi >>> 20) & 0x7ff) === 0) {
    // subnormal: normalize first
    value = x * 2 ** 52;
    exp = -52;
    view.setFloat64(0, value);
    hi = view.getUint32(0);
  }
  exp += ((hi >>> 20) & 0x7ff) - 1022;
  view.setFloat64(0, value);
  view.setUint32(0, (view.getUint32(0) & 0x800fffff) | (1022 << 20));
  return { frac: view.getFloat64(0), exp };
}

export function goLog(x: number): number {
  if (Number.isNaN(x) || x === Number.POSITIVE_INFINITY) return x;
  if (x < 0) return Number.NaN;
  if (x === 0) return Number.NEGATIVE_INFINITY;

  let { frac: f1, exp: ki } = frexp(x);
  if (f1 < SQRT2_OVER_2) {
    f1 *= 2;
    ki--;
  }
  const f = f1 - 1;
  const k = ki;

  const s = f / (2 + f);
  const s2 = s * s;
  const s4 = s2 * s2;
  const half = 0.5 * f; // exact, so (0.5*f)*f is hfsq before rounding
  const z = mulAdd(s4, mulAdd(s4, mulAdd(s4, L7, L5), L3), L1);
  const t2 = s4 * mulAdd(s4, mulAdd(s4, L6, L4), L2);
  // The compiler fuses every add or subtract that has a multiply operand, including hfsq (used
  // twice); when both operands of an add are products it fuses the first. So t1 is never rounded
  // on its own, and neither is hfsq: R = s2*z + t2, hfsq + R and hfsq - A.
  const R = mulAdd(s2, z, t2);
  const hr = mulAdd(half, f, R);
  const a = mulAdd(s, hr, k * LN2_LO);
  const c = mulAdd(half, f, -a);
  const b = c - f;
  return mulAdd(k, LN2_HI, -b);
}
