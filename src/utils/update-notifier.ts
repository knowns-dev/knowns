import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import chalk from "chalk";

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

interface CacheData {
	lastChecked: number;
	latestVersion: string;
}

export interface UpdateNotifierOptions {
	currentVersion: string;
	args?: string[];
	cwd?: string;
	cachePath?: string;
	cacheTtlMs?: number;
	force?: boolean;
	packageName?: string;
	packageManager?: PackageManager;
	fetchLatest?: () => Promise<string | null>;
	now?: () => Date;
	logger?: (message: string) => void;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Detect package manager from env and lockfiles
 */
export function detectPackageManager(cwd: string): PackageManager {
	const override = (process.env.KNOWN_PREFERRED_PM || "").toLowerCase() as PackageManager;
	if (override === "npm" || override === "pnpm" || override === "yarn" || override === "bun") {
		return override;
	}

	const ua = process.env.npm_config_user_agent || "";
	if (ua.startsWith("pnpm/")) return "pnpm";
	if (ua.startsWith("yarn/")) return "yarn";
	if (ua.startsWith("bun/")) return "bun";
	if (ua.startsWith("npm/")) return "npm";

	// Lockfile fallbacks
	if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
	if (existsSync(join(cwd, "bun.lock"))) return "bun";
	if (existsSync(join(cwd, "package-lock.json"))) return "npm";

	return "npm";
}

function compareVersions(a: string, b: string): number {
	const strip = (v: string) => v.replace(/^v/, "");
	const partsA = strip(a)
		.split(".")
		.map((p) => Number.parseInt(p, 10) || 0);
	const partsB = strip(b)
		.split(".")
		.map((p) => Number.parseInt(p, 10) || 0);
	const len = Math.max(partsA.length, partsB.length);
	for (let i = 0; i < len; i++) {
		const diff = (partsA[i] || 0) - (partsB[i] || 0);
		if (diff !== 0) return diff > 0 ? 1 : -1;
	}
	return 0;
}

function shouldSkip(args: string[] | undefined, force: boolean | undefined): boolean {
	if (force) return false;
	if (process.env.NO_UPDATE_CHECK === "1") return true;
	if (process.env.CI) return true;
	if (process.env.NODE_ENV === "test" || process.env.VITEST) return true;
	if (args?.includes("--plain")) return true;
	return false;
}

function getGlobalCachePath(explicit?: string): string {
	if (explicit) return explicit;
	return join(homedir(), ".knowns", "cli-cache.json");
}

function readCache(cachePath: string): CacheData | null {
	try {
		const raw = readFileSync(cachePath, "utf-8");
		const data = JSON.parse(raw) as CacheData;
		if (typeof data.lastChecked === "number" && typeof data.latestVersion === "string") {
			return data;
		}
	} catch {
		return null;
	}
	return null;
}

async function writeCache(cachePath: string, data: CacheData): Promise<void> {
	const dir = dirname(cachePath);
	if (dir && !existsSync(dir)) {
		await mkdir(dir, { recursive: true });
	}
	writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf-8");
}

async function fetchLatestVersion(packageName: string): Promise<string | null> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
		const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
			signal: controller.signal,
			headers: { accept: "application/json" },
		});
		clearTimeout(timer);
		if (!res.ok) return null;
		const data = (await res.json()) as { version?: string };
		return data.version ?? null;
	} catch {
		return null;
	}
}

export async function notifyCliUpdate(options: UpdateNotifierOptions): Promise<void> {
	const {
		currentVersion,
		args,
		cwd = process.cwd(),
		cachePath: explicitCachePath,
		cacheTtlMs = DEFAULT_TTL_MS,
		force = process.env.KNOWNS_UPDATE_CHECK === "1",
		packageName = "knowns",
		packageManager,
		fetchLatest = () => fetchLatestVersion(packageName),
		now = () => new Date(),
		logger = (message: string) => console.log(message),
	} = options;

	if (shouldSkip(args, force)) {
		return;
	}

	const cachePath = getGlobalCachePath(explicitCachePath);
	const pm = packageManager || detectPackageManager(cwd);

	const cache = readCache(cachePath);
	const isFresh = cache && now().getTime() - cache.lastChecked < cacheTtlMs;
	const latestFromCache = isFresh ? cache?.latestVersion : null;

	let latest = latestFromCache;

	if (!latestFromCache) {
		const fetched = await fetchLatest();
		if (fetched) {
			latest = fetched;
			await writeCache(cachePath, { latestVersion: fetched, lastChecked: now().getTime() });
		} else {
			// Network failure; stay silent
			return;
		}
	}

	if (!latest || compareVersions(latest, currentVersion) <= 0) {
		return;
	}

	const installCmd =
		pm === "pnpm"
			? "pnpm add -g knowns"
			: pm === "yarn"
				? "yarn global add knowns"
				: pm === "bun"
					? "bun add -g knowns"
					: "npm i -g knowns";

	const message =
		chalk.bgYellow.black(" UPDATE ") +
		chalk.yellowBright(` v${latest} available (current v${currentVersion}) `) +
		chalk.gray(`→ ${installCmd}`);

	logger("");
	logger(message);
	logger("");
}
