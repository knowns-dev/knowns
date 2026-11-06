// Port of the update notifier of internal/util/update_notifier.go: the npm registry lookup and the
// cached background check that prints " UPDATE  vX available" after a command.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VERSION } from "../../version.ts";
import { type Env, userHomeDir } from "../setup/env.ts";
import { compareVersions, normalizeVersionTag } from "./version.ts";

export const NPM_REGISTRY_URL = "https://registry.npmjs.org/knowns/latest";
const CACHE_TTL_MS = 3_600_000;
const FETCH_TIMEOUT_MS = 2000;

/** FetchLatestVersion: "" on any error. The deadline is a plain timer (Bun on Windows ignores AbortSignal.timeout). */
export async function fetchLatestVersion(
  fetchFn: typeof fetch = fetch,
  url: string = NPM_REGISTRY_URL,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetchFn(url, { signal: controller.signal });
    if (resp.status !== 200) return "";
    const body = (await resp.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

export const formatUpdateNotification = (latest: string, current: string): string =>
  `\n UPDATE  ${normalizeVersionTag(latest)} available (current ${normalizeVersionTag(current)}) → knowns update\n`;

function cachePath(env: Env): string {
  try {
    return join(userHomeDir(env), ".knowns", "cli-cache.json");
  } catch {
    return "";
  }
}

/** CheckForUpdate: the notice to print, or "" (silent on every error). Caches for an hour. */
export async function checkForUpdate(
  env: Env = process.env,
  opts: { fetch?: typeof fetch; url?: string; now?: () => number; version?: string } = {},
): Promise<string> {
  const now = opts.now ?? Date.now;
  const current = opts.version ?? VERSION;
  const path = cachePath(env);
  let latest = "";
  let cached: { lastChecked: number; latestVersion: string } | undefined;
  if (path !== "") {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      cached = {
        lastChecked: typeof raw.lastChecked === "number" ? raw.lastChecked : 0,
        latestVersion: typeof raw.latestVersion === "string" ? raw.latestVersion : "",
      };
    } catch {
      cached = undefined;
    }
  }
  if (cached && now() - cached.lastChecked < CACHE_TTL_MS) latest = cached.latestVersion;
  else {
    const fetched = await fetchLatestVersion(opts.fetch, opts.url);
    if (fetched === "") return "";
    latest = fetched;
    if (path !== "") {
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
        writeFileSync(path, JSON.stringify({ lastChecked: now(), latestVersion: fetched }), {
          mode: 0o644,
        });
      } catch {
        // best effort
      }
    }
  }
  if (latest === "" || compareVersions(latest, current) <= 0) return "";
  return formatUpdateNotification(latest, current);
}
