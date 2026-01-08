import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { detectPackageManager, notifyCliUpdate } from "./update-notifier";

describe("update notifier", () => {
	let tempDir: string;
	let cachePath: string;
	const now = new Date("2024-01-01T00:00:00.000Z");

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "knowns-update-"));
		cachePath = join(tempDir, "cli-cache.json");
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	test("uses fresh cache and skips fetch", async () => {
		await writeFile(cachePath, JSON.stringify({ lastChecked: now.getTime() - 1000, latestVersion: "0.8.0" }));
		const logs: string[] = [];
		const fetchLatest = vi.fn();

		await notifyCliUpdate({
			currentVersion: "0.7.0",
			cachePath,
			fetchLatest,
			force: true,
			now: () => now,
			packageManager: "npm",
			logger: (msg) => logs.push(msg),
		});

		expect(fetchLatest).not.toHaveBeenCalled();
		expect(logs).toHaveLength(3); // empty line, message, empty line
		expect(logs[1]).toContain("0.8.0");
	});

	test("fetches when cache is stale and updates cache", async () => {
		await writeFile(cachePath, JSON.stringify({ lastChecked: now.getTime() - 3_700_000, latestVersion: "0.7.1" }));
		const logs: string[] = [];
		const fetchLatest = vi.fn().mockResolvedValue("0.9.0");

		await notifyCliUpdate({
			currentVersion: "0.7.0",
			cachePath,
			fetchLatest,
			force: true,
			now: () => now,
			packageManager: "npm",
			logger: (msg) => logs.push(msg),
		});

		expect(fetchLatest).toHaveBeenCalled();
		expect(logs).toHaveLength(3); // empty line, message, empty line
		expect(logs[1]).toContain("0.9.0");

		const cached = JSON.parse(await readFile(cachePath, "utf-8"));
		expect(cached.latestVersion).toBe("0.9.0");
		expect(cached.lastChecked).toBe(now.getTime());
	});

	test("is quiet when up-to-date", async () => {
		const logs: string[] = [];
		const fetchLatest = vi.fn().mockResolvedValue("0.7.0");

		await notifyCliUpdate({
			currentVersion: "0.7.0",
			cachePath,
			fetchLatest,
			force: true,
			now: () => now,
			packageManager: "npm",
			logger: (msg) => logs.push(msg),
		});

		expect(fetchLatest).toHaveBeenCalled();
		expect(logs).toHaveLength(0);
	});

	test("handles fetch failures quietly", async () => {
		const logs: string[] = [];
		const fetchLatest = vi.fn().mockResolvedValue(null);

		await notifyCliUpdate({
			currentVersion: "0.7.0",
			cachePath,
			fetchLatest,
			force: true,
			now: () => now,
			packageManager: "npm",
			logger: (msg) => logs.push(msg),
		});

		expect(fetchLatest).toHaveBeenCalled();
		expect(logs).toHaveLength(0);
	});

	test("detects package manager via user agent", () => {
		const originalUA = process.env.npm_config_user_agent;
		process.env.npm_config_user_agent = "pnpm/9.0.0 node/v20.0.0 darwin arm64";
		expect(detectPackageManager(process.cwd())).toBe("pnpm");
		process.env.npm_config_user_agent = originalUA;
	});
});
