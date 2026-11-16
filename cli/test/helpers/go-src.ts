// The Go implementation is no longer in this repository (KN-NDD5YY). Differential tests compare the
// TypeScript CLI with Go built from the last commit that still had it, pinned in
// scripts/go-oracle.ts. That script checks the commit out and exports KNOWNS_GO_SRC (the checkout)
// and KNOWNS_GO_BIN (the CLI built from it). Helpers that compile Go against internal/ packages
// build inside KNOWNS_GO_SRC; without it, or without a Go toolchain, they report unavailable and
// their tests skip.
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

const fromEnv = process.env.KNOWNS_GO_SRC;

/**
 * The pinned Go checkout, or undefined when KNOWNS_GO_SRC is unset or is not a Go module root.
 * Real path: go build resolves its cwd (macOS /var -> /private/var), and -overlay keys must match.
 */
export const GO_SRC: string | undefined =
  fromEnv && existsSync(join(fromEnv, "go.mod")) ? realpathSync(fromEnv) : undefined;

/** True when Go code can be compiled: the pinned checkout exists and `go` is on PATH. */
export const hasGoSrc: boolean =
  GO_SRC !== undefined && Bun.which("go", { PATH: process.env.PATH ?? "" }) !== null;

/** A path inside the pinned checkout; throws when there is none (callers check hasGoSrc first). */
export function goSrcPath(...parts: string[]): string {
  if (!GO_SRC) throw new Error("KNOWNS_GO_SRC is not set; run `bun scripts/go-oracle.ts`");
  return join(GO_SRC, ...parts);
}
