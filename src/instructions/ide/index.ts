/**
 * IDE Configuration Templates
 *
 * Templates for different IDE integrations.
 * All IDEs without skill support use full guidelines from agents.md.
 */

import cursorMcpJson from "./cursor/mcp.json";
import cursorRulesMd from "./cursor/rules.md";
import windsurfRulesMd from "./windsurf/rules.md";

/**
 * IDE configuration definition
 */
export interface IDEConfig {
	/** IDE name */
	name: string;
	/** Target directory (relative to project root) */
	targetDir: string;
	/** Files to create */
	files: {
		/** Target filename */
		filename: string;
		/** Content (string or object for JSON) */
		content: string | object;
		/** Whether to stringify as JSON */
		isJson?: boolean;
	}[];
}

/**
 * Cursor IDE configuration
 */
export const CURSOR_CONFIG: IDEConfig = {
	name: "cursor",
	targetDir: ".cursor",
	files: [
		{
			filename: "mcp.json",
			content: cursorMcpJson,
			isJson: true,
		},
		{
			filename: "rules/knowns.md",
			content: cursorRulesMd,
		},
	],
};

/**
 * Windsurf IDE configuration
 */
export const WINDSURF_CONFIG: IDEConfig = {
	name: "windsurf",
	targetDir: ".windsurf",
	files: [
		{
			filename: "rules.md",
			content: windsurfRulesMd,
		},
	],
};

/**
 * All IDE configurations
 */
export const IDE_CONFIGS: IDEConfig[] = [CURSOR_CONFIG, WINDSURF_CONFIG];

/**
 * Get IDE config by name
 */
export function getIDEConfig(name: string): IDEConfig | undefined {
	return IDE_CONFIGS.find((c) => c.name === name);
}

/**
 * Get all IDE names
 */
export function getIDENames(): string[] {
	return IDE_CONFIGS.map((c) => c.name);
}

export default IDE_CONFIGS;
