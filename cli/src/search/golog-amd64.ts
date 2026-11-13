// math.Log as Go computes it on amd64: a port of $GOROOT/src/math/log_amd64.s (selected by
// log_asm.go). It is the same FreeBSD e_log.c algorithm as the pure-Go `log`, with no fused
// multiply-adds (the Go amd64 compiler does not fuse at GOAMD64=v1, the release setting), but it
// differs from the pure-Go version in three edge cases that this file reproduces exactly:
//   - Frexp is inlined as "mantissa | 0.5, exponent - 0x3fe" and does not normalize subnormals,
//     so a subnormal argument yields a different (wrong, but Go-identical) result;
//   - the reduction test is `f1 <= sqrt(2)/2` (CMPSD predicate NLT), the pure-Go one is `<`;
//   - special cases are decided on the raw bits: +-0 gives -Inf, any negative bit pattern gives
//     NaN, +Inf and positive NaN return x.

const bits = new DataView(new ArrayBuffer(8));
/** The double with these high and low words (the constants' exact bit patterns). */
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
const H_SQRT2 = f64(0x3fe6a09e, 0x667f3bcd);

export function goLogAmd64(x: number): number {
  bits.setFloat64(0, x);
  const hi = bits.getUint32(0);
  const lo = bits.getUint32(4);
  if (((hi & 0x7fffffff) | lo) === 0) return Number.NEGATIVE_INFINITY;
  if (hi >>> 31 === 1) return Number.NaN; // signed compare: every negative bit pattern
  if (hi >= 0x7ff00000) return x; // +Inf or NaN

  const k0 = ((hi >>> 20) & 0x7ff) - 0x3fe;
  bits.setUint32(0, (hi & 0x000fffff) | 0x3fe00000); // mantissa | 0.5
  let f1 = bits.getFloat64(0);
  let k = k0;
  if (f1 <= H_SQRT2) {
    k -= 1;
    f1 *= 2;
  }
  const f = f1 - 1;
  const s = f / (2 + f);
  const s2 = s * s;
  const s4 = s2 * s2;
  const t1 = s2 * (L1 + s4 * (L3 + s4 * (L5 + s4 * L7)));
  const t2 = s4 * (L2 + s4 * (L4 + s4 * L6));
  const r = t1 + t2;
  const hfsq = 0.5 * f * f;
  return k * LN2_HI - (hfsq - (s * (hfsq + r) + k * LN2_LO) - f);
}
