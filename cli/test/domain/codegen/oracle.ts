// Drives the Go codegen engine (test/helpers/codegen-oracle.go) in one process for a batch of
// requests. `GO_ORACLE` is false when `go` is not installed; differential tests then skip.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const GO_ORACLE = Bun.which("go") !== null;

const repoRoot = resolve(import.meta.dir, "../../../..");

export interface OracleRequest {
  op: "render" | "validate" | "run";
  tpl?: string;
  vars?: Record<string, string>;
  root?: string;
  tmpl?: unknown;
  dryRun?: boolean;
}

export interface OracleResponse {
  out: string;
  err: string;
  created: string[] | null;
  modified: string[] | null;
  skipped: string[] | null;
}

let binary: string | undefined;

function oracleBinary(): string {
  if (binary) return binary;
  const dir = mkdtempSync(join(tmpdir(), "codegen-oracle-"));
  const out = join(dir, process.platform === "win32" ? "oracle.exe" : "oracle");
  const r = spawnSync("go", ["build", "-o", out, "cli/test/helpers/codegen-oracle.go"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(
      `go build failed: status=${r.status} signal=${r.signal} error=${r.error} stderr=${r.stderr} stdout=${r.stdout} cwd=${repoRoot}`,
    );
  }
  binary = out;
  return out;
}

// The first `go build` on a cold cache can take longer than bun's 5s test/hook timeout (Windows CI
// and the full run hit this), and a sync call cannot be interrupted. Build while the module loads,
// outside any timed hook; a failure is rethrown with details by the first askGo.
if (GO_ORACLE) {
  try {
    oracleBinary();
  } catch {
    // reported by askGo
  }
}

export function askGo(requests: OracleRequest[]): OracleResponse[] {
  const input = `${requests.map((r) => JSON.stringify(r)).join("\n")}\n`;
  const r = spawnSync(oracleBinary(), [], { input, encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`oracle failed: ${r.stderr}`);
  return r.stdout
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as OracleResponse);
}
