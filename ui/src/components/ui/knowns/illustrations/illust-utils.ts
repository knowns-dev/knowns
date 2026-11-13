export type Pt = { x: number; y: number };

/** Point at `t` (0–1) on a cubic Bézier. */
export function cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

/** SVG path data for a cubic Bézier. */
export function cubicPath(p0: Pt, p1: Pt, p2: Pt, p3: Pt): string {
  const f = (p: Pt) => `${+p.x.toFixed(1)} ${+p.y.toFixed(1)}`;
  return `M ${f(p0)} C ${f(p1)}, ${f(p2)}, ${f(p3)}`;
}

/** Visible prefix of a prompt being typed, `at` ms after it started. */
export function typedPrefix(text: string, at: number, msPerChar = 34): string {
  if (at <= 0) return "";
  return text.slice(0, Math.min(text.length, Math.floor(at / msPerChar)));
}
