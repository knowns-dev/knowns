// Port of the version helpers in internal/util (CompareVersions, NormalizeVersionTag).

/** CompareVersions: 1 if a > b, -1 if a < b, 0 if equal; non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".");
  const pb = b.replace(/^v/, "").split(".");
  const n = Math.max(pa.length, pb.length);
  const atoi = (s: string | undefined): number =>
    /^[+-]?\d+$/.test(s ?? "") ? Number.parseInt(s as string, 10) : 0;
  for (let i = 0; i < n; i++) {
    const va = atoi(pa[i]);
    const vb = atoi(pb[i]);
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

/** NormalizeVersionTag: a "v" prefix unless the version is empty or already has one. */
export function normalizeVersionTag(version: string): string {
  const v = version.trim();
  if (v === "" || v.startsWith("v")) return v;
  return `v${v}`;
}
