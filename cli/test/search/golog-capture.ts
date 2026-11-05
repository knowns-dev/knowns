// Prints math.Log(x) bit patterns (hex, one per line) for every logSamples() argument, computed
// by a Go helper (search-helper.go built for the machine/GOARCH under test). Used to produce
// fixtures/golog-<arch>.txt and to cross-check hosts:
//   bun test/search/golog-capture.ts /path/to/search-helper > out.txt
// NaN results are normalised to "nan" because Go does not promise a payload.
import { logSamples } from "./golog-samples.ts";

const exe = process.argv[2];
if (!exe) throw new Error("usage: golog-capture.ts <search-helper>");
const xs = logSamples();
const body = `[${xs
  .map(
    (x) => `{"op":"log","a":${Object.is(x, -0) ? "-0" : Number.isFinite(x) ? String(x) : "null"}}`,
  )
  .join(",")}]`;
const res = Bun.spawnSync([exe], {
  stdin: new TextEncoder().encode(body),
  stdout: "pipe",
  stderr: "pipe",
});
if (res.exitCode !== 0) throw new Error(res.stderr.toString());
const out = JSON.parse(res.stdout.toString()) as ({ ok: string } | { error: string })[];
const lines = out.map((r, i) => {
  if ("error" in r) throw new Error(r.error);
  const x = xs[i] as number;
  if (!Number.isFinite(x)) return "special";
  const v = BigInt(`0x${r.ok}`);
  return (v & 0x7ff0000000000000n) === 0x7ff0000000000000n && (v & 0xfffffffffffffn) !== 0n
    ? "nan"
    : r.ok;
});
console.log(lines.join("\n"));
