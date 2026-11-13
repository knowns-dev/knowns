// Single source of the release version for build scripts. The version is never stored in
// package.json: it is the release tag. Order: KNOWNS_VERSION env (publish.yml sets it from the
// tag), an exact git tag on HEAD, then the untagged fallback. A leading "v" is stripped so
// `v1.0.0` and `1.0.0` are the same.
//
// The untagged fallback is the Go parity baseline that unbuilt source also reports
// (src/version.ts): an untagged local build must still match the Go 0.34.1 oracle in the
// compiled-binary tests. It goes away with the Go oracle in the switch merge (spec D3).
import { PARITY_BASELINE_VERSION } from "../src/version.ts";

export const UNTAGGED_VERSION = PARITY_BASELINE_VERSION;

export function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v/, "");
}

export function resolveVersion(
  env: Record<string, string | undefined> = process.env,
  gitTag: () => string | undefined = exactGitTag,
): string {
  const fromEnv = env.KNOWNS_VERSION ? normalizeVersion(env.KNOWNS_VERSION) : "";
  if (fromEnv) return fromEnv;
  const tag = gitTag();
  if (tag) return normalizeVersion(tag);
  return UNTAGGED_VERSION;
}

function exactGitTag(): string | undefined {
  try {
    const r = Bun.spawnSync(
      ["git", "describe", "--tags", "--exact-match", "--match", "v*", "HEAD"],
      {
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    if (r.exitCode !== 0) return undefined;
    return r.stdout.toString().trim() || undefined;
  } catch {
    return undefined;
  }
}
