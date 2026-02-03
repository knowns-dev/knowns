/**
 * Project detection and management handlers for MCP
 * Auto-detect knowns projects and manage current working project
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// Global state for current project
let currentProjectRoot: string | null = null;

/**
 * Get the current project root
 * Priority: 1. Explicitly set project, 2. KNOWNS_PROJECT_ROOT env, 3. process.cwd()
 */
export function getProjectRoot(): string {
	if (currentProjectRoot) {
		return currentProjectRoot;
	}
	if (process.env.KNOWNS_PROJECT_ROOT) {
		return process.env.KNOWNS_PROJECT_ROOT;
	}
	return process.cwd();
}

/**
 * Set the current project root
 */
export function setProjectRoot(path: string): void {
	currentProjectRoot = path;
}

/**
 * Common workspace directories to scan for projects
 */
function getWorkspaceDirectories(): string[] {
	const home = homedir();
	const dirs: string[] = [];

	// Common workspace locations
	const commonPaths = [
		join(home, "Workspaces"),
		join(home, "workspace"),
		join(home, "projects"),
		join(home, "Projects"),
		join(home, "dev"),
		join(home, "Development"),
		join(home, "Code"),
		join(home, "code"),
		join(home, "repos"),
		join(home, "Repos"),
		join(home, "src"),
		join(home, "Documents", "Projects"),
		join(home, "Documents", "GitHub"),
		join(home, "GitHub"),
	];

	for (const path of commonPaths) {
		if (existsSync(path)) {
			dirs.push(path);
		}
	}

	return dirs;
}

/**
 * Scan a directory for knowns projects (directories containing .knowns/)
 */
function scanForKnownsProjects(baseDir: string, maxDepth = 2): string[] {
	const projects: string[] = [];

	function scan(dir: string, depth: number) {
		if (depth > maxDepth) return;

		try {
			const entries = readdirSync(dir);

			// Check if this directory has .knowns/
			if (entries.includes(".knowns")) {
				const knownsPath = join(dir, ".knowns");
				if (existsSync(knownsPath) && statSync(knownsPath).isDirectory()) {
					projects.push(dir);
					return; // Don't scan subdirectories of a knowns project
				}
			}

			// Scan subdirectories
			for (const entry of entries) {
				// Skip hidden directories and common non-project directories
				if (entry.startsWith(".") || entry === "node_modules" || entry === "vendor") {
					continue;
				}

				const entryPath = join(dir, entry);
				try {
					if (statSync(entryPath).isDirectory()) {
						scan(entryPath, depth + 1);
					}
				} catch {
					// Skip directories we can't access
				}
			}
		} catch {
			// Skip directories we can't read
		}
	}

	scan(baseDir, 0);
	return projects;
}

/**
 * Detect all knowns projects on the system
 */
export function detectKnownsProjects(): Array<{ path: string; name: string }> {
	const workspaceDirs = getWorkspaceDirectories();
	const allProjects: string[] = [];

	// Also check current directory
	const cwd = process.cwd();
	if (existsSync(join(cwd, ".knowns"))) {
		allProjects.push(cwd);
	}

	// Scan workspace directories
	for (const dir of workspaceDirs) {
		const projects = scanForKnownsProjects(dir);
		for (const project of projects) {
			if (!allProjects.includes(project)) {
				allProjects.push(project);
			}
		}
	}

	// Sort and return with names
	return allProjects.sort().map((path) => ({
		path,
		name: basename(path),
	}));
}

// Tool definitions
export const projectTools: Tool[] = [
	{
		name: "detect_projects",
		description:
			"Detect all Knowns projects on the system. Scans common workspace directories for projects with .knowns/ folder. Use this to find available projects when the current working directory is not set correctly.",
		inputSchema: {
			type: "object" as const,
			properties: {
				additionalPaths: {
					type: "array",
					items: { type: "string" },
					description: "Additional directories to scan for projects",
				},
			},
		},
	},
	{
		name: "set_project",
		description:
			"Set the current working project for all subsequent Knowns MCP operations. Use this after detect_projects to select which project to work with.",
		inputSchema: {
			type: "object" as const,
			properties: {
				projectRoot: {
					type: "string",
					description: "Absolute path to the project root directory (must contain .knowns/ folder)",
				},
			},
			required: ["projectRoot"],
		},
	},
	{
		name: "get_current_project",
		description: "Get the currently active project path and verify it's valid.",
		inputSchema: {
			type: "object" as const,
			properties: {},
		},
	},
];

// Handlers
export function handleDetectProjects(input: { additionalPaths?: string[] }): {
	projects: Array<{ path: string; name: string }>;
	currentProject: string | null;
	note: string;
} {
	let projects = detectKnownsProjects();

	// Scan additional paths if provided
	if (input.additionalPaths) {
		for (const path of input.additionalPaths) {
			if (existsSync(path)) {
				const additional = scanForKnownsProjects(path);
				for (const project of additional) {
					if (!projects.find((p) => p.path === project)) {
						projects.push({ path: project, name: basename(project) });
					}
				}
			}
		}
	}

	// Sort by name
	projects = projects.sort((a, b) => a.name.localeCompare(b.name));

	const current = currentProjectRoot || process.env.KNOWNS_PROJECT_ROOT || null;

	return {
		projects,
		currentProject: current,
		note:
			projects.length === 0
				? "No Knowns projects found. Initialize a project with 'knowns init'."
				: projects.length === 1
					? "Found 1 project. Use set_project to activate it."
					: `Found ${projects.length} projects. Use set_project to select one.`,
	};
}

export function handleSetProject(input: { projectRoot: string }): {
	success: boolean;
	projectRoot: string;
	message: string;
} {
	const { projectRoot } = input;

	// Validate path exists
	if (!existsSync(projectRoot)) {
		return {
			success: false,
			projectRoot,
			message: `Path does not exist: ${projectRoot}`,
		};
	}

	// Validate .knowns/ exists
	const knownsPath = join(projectRoot, ".knowns");
	if (!existsSync(knownsPath)) {
		return {
			success: false,
			projectRoot,
			message: `Not a Knowns project (no .knowns/ folder): ${projectRoot}`,
		};
	}

	// Set the project root
	setProjectRoot(projectRoot);

	return {
		success: true,
		projectRoot,
		message: `Project set to: ${projectRoot}. All subsequent operations will use this project.`,
	};
}

export function handleGetCurrentProject(): {
	projectRoot: string;
	isExplicitlySet: boolean;
	isValid: boolean;
	source: "explicit" | "env" | "cwd";
} {
	let source: "explicit" | "env" | "cwd" = "cwd";
	let projectRoot = process.cwd();

	if (currentProjectRoot) {
		source = "explicit";
		projectRoot = currentProjectRoot;
	} else if (process.env.KNOWNS_PROJECT_ROOT) {
		source = "env";
		projectRoot = process.env.KNOWNS_PROJECT_ROOT;
	}

	const isValid = existsSync(join(projectRoot, ".knowns"));

	return {
		projectRoot,
		isExplicitlySet: source === "explicit",
		isValid,
		source,
	};
}
