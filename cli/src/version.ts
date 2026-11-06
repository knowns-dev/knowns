// The release version, injected at build time via `--define KNOWNS_VERSION="..."` by
// scripts/build.ts (env KNOWNS_VERSION, else an exact git tag on HEAD, else this baseline; see
// scripts/version.ts). Every compiled binary, release or not, gets the define, so the value below
// never reaches a shipped build. package.json carries no version.
//
// Unbuilt source (`bun src/main.ts`, which the diff tests spawn with a minimal env from a temp
// cwd) reports the Go parity baseline instead, because those tests compare its output with the
// Go 0.34.1 oracle. Drop this fallback with the Go oracle in the switch merge (spec D3).
declare const KNOWNS_VERSION: string | undefined;

export const PARITY_BASELINE_VERSION = "0.34.1";

export const VERSION: string =
  typeof KNOWNS_VERSION === "string" ? KNOWNS_VERSION : PARITY_BASELINE_VERSION;
