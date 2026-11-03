// Replaced at build time via `--define KNOWNS_VERSION="..."`; falls back to package.json in dev.
import pkg from "../package.json" with { type: "json" };

declare const KNOWNS_VERSION: string | undefined;

export const VERSION: string = typeof KNOWNS_VERSION === "string" ? KNOWNS_VERSION : pkg.version;
