/**
 * Guidelines command
 * Display Knowns usage guidelines for AI agents
 */

import chalk from "chalk";
import { Command } from "commander";
import { CLIGuidelines, MCPGuidelines, UnifiedGuidelines } from "../instructions/guidelines";

type Section = "all" | "core" | "workflow" | "mcp" | "cli" | "mistakes" | "context";

/**
 * Get guidelines content by section and mode
 */
function getGuidelinesContent(section: Section, mode: "cli" | "mcp" | "unified"): string {
	const guidelines = mode === "mcp" ? MCPGuidelines : mode === "cli" ? CLIGuidelines : UnifiedGuidelines;

	switch (section) {
		case "core":
			return guidelines.core;
		case "workflow":
			return [
				"# Workflow Reference",
				"",
				"## Task Creation",
				guidelines.workflow.creation,
				"",
				"---",
				"",
				"## Task Execution",
				guidelines.workflow.execution,
				"",
				"---",
				"",
				"## Task Completion",
				guidelines.workflow.completion,
			].join("\n");
		case "mcp":
			if (mode === "cli") {
				return "MCP guidelines not available in CLI-only mode. Use --mode unified or --mode mcp.";
			}
			return MCPGuidelines.commands;
		case "cli":
			if (mode === "mcp") {
				return "CLI guidelines not available in MCP-only mode. Use --mode unified or --mode cli.";
			}
			return CLIGuidelines.commands;
		case "mistakes":
			return guidelines.mistakes;
		case "context":
			return guidelines.contextOptimization;
		default:
			return guidelines.getFullReference();
	}
}

/**
 * Search within guidelines
 */
function searchGuidelines(query: string, mode: "cli" | "mcp" | "unified"): string {
	const guidelines = mode === "mcp" ? MCPGuidelines : mode === "cli" ? CLIGuidelines : UnifiedGuidelines;
	const content = guidelines.getFullReference();

	const lines = content.split("\n");
	const results: string[] = [];
	const queryLower = query.toLowerCase();

	let currentSection = "";
	const contextBefore: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Track section headers
		if (line.startsWith("# ") || line.startsWith("## ")) {
			currentSection = line;
		}

		// Check for match
		if (line.toLowerCase().includes(queryLower)) {
			// Add section header if not already added
			if (results.length === 0 || !results.includes(currentSection)) {
				if (results.length > 0) results.push("");
				results.push(currentSection);
				results.push("");
			}

			// Add context (2 lines before and after)
			const start = Math.max(0, i - 2);
			const end = Math.min(lines.length - 1, i + 2);

			for (let j = start; j <= end; j++) {
				const contextLine = j === i ? `>>> ${lines[j]}` : `    ${lines[j]}`;
				if (!results.includes(contextLine)) {
					results.push(contextLine);
				}
			}
			results.push("");
		}
	}

	if (results.length === 0) {
		return `No matches found for "${query}"`;
	}

	return results.join("\n");
}

export const guidelinesCommand = new Command("guidelines")
	.description("Display Knowns usage guidelines for AI agents")
	.argument("[section]", "Section to display: core, workflow, mcp, cli, mistakes, context (default: all)")
	.option("--plain", "Plain text output for AI")
	.option("--mode <mode>", "Guidelines mode: cli, mcp, unified (default: unified)", "unified")
	.option("--search <query>", "Search within guidelines")
	.option("--compact", "Show only core rules (what goes in CLAUDE.md)")
	.action(
		(section: string | undefined, options: { plain?: boolean; mode?: string; search?: string; compact?: boolean }) => {
			const mode = (options.mode || "unified") as "cli" | "mcp" | "unified";

			// Validate mode
			if (!["cli", "mcp", "unified"].includes(mode)) {
				console.error(chalk.red(`Invalid mode: ${mode}. Use: cli, mcp, unified`));
				process.exit(1);
			}

			let content: string;

			if (options.search) {
				content = searchGuidelines(options.search, mode);
			} else if (options.compact) {
				const guidelines = mode === "mcp" ? MCPGuidelines : mode === "cli" ? CLIGuidelines : UnifiedGuidelines;
				content = guidelines.getCompact();
			} else {
				const sectionArg = (section || "all") as Section;

				// Validate section
				const validSections = ["all", "core", "workflow", "mcp", "cli", "mistakes", "context"];
				if (!validSections.includes(sectionArg)) {
					console.error(chalk.red(`Invalid section: ${sectionArg}`));
					console.error(chalk.gray(`Valid sections: ${validSections.join(", ")}`));
					process.exit(1);
				}

				content = getGuidelinesContent(sectionArg, mode);
			}

			if (options.plain) {
				console.log(content);
			} else {
				console.log();
				console.log(chalk.bold("📚 Knowns Guidelines"));
				console.log(chalk.gray(`Mode: ${mode}`));
				console.log();
				console.log(content);
				console.log();
			}
		},
	);
