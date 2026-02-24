/**
 * Auto-sync utilities
 * Automatically sync skills when CLI version changes
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderString } from "../codegen/renderer";
import { SKILLS } from "../instructions/skills";
import { findProjectRoot } from "./find-project-root";

const VERSION_FILE = ".version";

/**
 * Platform configurations for auto-sync
 */
const PLATFORMS = [
	{ id: "claude", dir: ".claude/skills" },
	{ id: "antigravity", dir: ".agent/skills" },
] as const;

interface VersionInfo {
	cliVersion: string;
	syncedAt: string;
}

/**
 * Get version file path for a platform
 */
function getVersionFilePath(projectRoot: string, platformDir: string): string {
	return join(projectRoot, platformDir, VERSION_FILE);
}

/**
 * Read current synced version for a platform
 */
function getSyncedVersion(projectRoot: string, platformDir: string): VersionInfo | null {
	const versionFile = getVersionFilePath(projectRoot, platformDir);
	if (!existsSync(versionFile)) {
		return null;
	}

	try {
		const content = readFileSync(versionFile, "utf-8");
		return JSON.parse(content);
	} catch {
		return null;
	}
}

/**
 * Write version info after sync for a platform
 */
function writeSyncedVersion(projectRoot: string, platformDir: string, cliVersion: string): void {
	const skillsDir = join(projectRoot, platformDir);
	const versionFile = getVersionFilePath(projectRoot, platformDir);

	if (!existsSync(skillsDir)) {
		mkdirSync(skillsDir, { recursive: true });
	}

	const info: VersionInfo = {
		cliVersion,
		syncedAt: new Date().toISOString(),
	};

	writeFileSync(versionFile, JSON.stringify(info, null, 2), "utf-8");
}

/**
 * Check if folder is a deprecated skill folder
 */
function isDeprecatedSkillFolder(name: string): boolean {
	return name.startsWith("knowns.") || name.startsWith("kn:");
}

/**
 * Sync skills to a single platform directory
 */
function syncSkillsToDir(skillsDir: string, mode: "mcp" | "cli" = "mcp"): { synced: number; removed: number } {
	// Create directory if not exists
	if (!existsSync(skillsDir)) {
		mkdirSync(skillsDir, { recursive: true });
	}

	// Clean up deprecated skill folders
	let removed = 0;
	const entries = readdirSync(skillsDir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isDirectory() && isDeprecatedSkillFolder(entry.name)) {
			const deprecatedPath = join(skillsDir, entry.name);
			rmSync(deprecatedPath, { recursive: true, force: true });
			removed++;
		}
	}

	// Sync all skills
	let synced = 0;
	for (const skill of SKILLS) {
		const skillFolder = join(skillsDir, skill.folderName);
		const skillFile = join(skillFolder, "SKILL.md");

		// Render content with mode
		const renderedContent = renderString(skill.content, {
			mcp: mode === "mcp",
			cli: mode === "cli",
		});

		if (!existsSync(skillFolder)) {
			mkdirSync(skillFolder, { recursive: true });
		}

		// Always write (force update)
		writeFileSync(skillFile, renderedContent, "utf-8");
		synced++;
	}

	return { synced, removed };
}

/**
 * Check and auto-sync skills if version changed
 * Returns true if sync was performed
 */
export function checkAndAutoSync(cliVersion: string): {
	synced: boolean;
	message?: string;
} {
	const projectRoot = findProjectRoot();

	// Not in a knowns project
	if (!projectRoot) {
		return { synced: false };
	}

	// Check each platform and sync if needed
	const platformsToSync: Array<{ id: string; dir: string; oldVersion: string }> = [];

	for (const platform of PLATFORMS) {
		const platformDir = join(projectRoot, platform.dir);

		// Only sync if platform directory exists (was initialized)
		if (!existsSync(platformDir)) {
			continue;
		}

		const syncedInfo = getSyncedVersion(projectRoot, platform.dir);
		const needsSync = !syncedInfo || syncedInfo.cliVersion !== cliVersion;

		if (needsSync) {
			platformsToSync.push({
				id: platform.id,
				dir: platform.dir,
				oldVersion: syncedInfo?.cliVersion || "none",
			});
		}
	}

	if (platformsToSync.length === 0) {
		return { synced: false };
	}

	// Perform silent sync for each platform
	try {
		let totalSynced = 0;
		const platformNames: string[] = [];

		for (const platform of platformsToSync) {
			const skillsDir = join(projectRoot, platform.dir);
			const { synced } = syncSkillsToDir(skillsDir);
			writeSyncedVersion(projectRoot, platform.dir, cliVersion);
			totalSynced += synced;
			platformNames.push(platform.id);
		}

		const oldVersion = platformsToSync[0]?.oldVersion || "none";
		const platforms = platformNames.join(", ");
		const message = `✓ Auto-synced ${totalSynced} skills for ${platforms} (${oldVersion} → ${cliVersion})`;

		return { synced: true, message };
	} catch {
		// Silent fail - don't block CLI usage
		return { synced: false };
	}
}

/**
 * Force sync skills and update version
 */
export function forceSyncSkills(
	projectRoot: string,
	cliVersion: string,
	mode: "mcp" | "cli" = "mcp",
): {
	synced: number;
	removed: number;
} {
	let totalSynced = 0;
	let totalRemoved = 0;

	for (const platform of PLATFORMS) {
		const skillsDir = join(projectRoot, platform.dir);

		// Only sync if platform directory exists
		if (!existsSync(skillsDir)) {
			continue;
		}

		const { synced, removed } = syncSkillsToDir(skillsDir, mode);
		writeSyncedVersion(projectRoot, platform.dir, cliVersion);
		totalSynced += synced;
		totalRemoved += removed;
	}

	return { synced: totalSynced, removed: totalRemoved };
}
