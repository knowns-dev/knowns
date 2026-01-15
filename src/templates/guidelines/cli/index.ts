/**
 * Knowns CLI Guidelines Module
 *
 * CLI-specific guidelines for AI agents using Knowns CLI commands.
 */

import commandsReferenceMd from "./commands-reference.md";
import commonMistakesMd from "./common-mistakes.md";
import contextOptimizationMd from "./context-optimization.md";
// CLI-specific guidelines
import coreRulesMd from "./core-rules.md";
import workflowCompletionMd from "./workflow-completion.md";
import workflowCreationMd from "./workflow-creation.md";
import workflowExecutionMd from "./workflow-execution.md";

// Export individual guidelines (trimmed)
export const CLI_CORE_RULES = coreRulesMd.trim();
export const CLI_COMMANDS_REFERENCE = commandsReferenceMd.trim();
export const CLI_WORKFLOW_CREATION = workflowCreationMd.trim();
export const CLI_WORKFLOW_EXECUTION = workflowExecutionMd.trim();
export const CLI_WORKFLOW_COMPLETION = workflowCompletionMd.trim();
export const CLI_COMMON_MISTAKES = commonMistakesMd.trim();
export const CLI_CONTEXT_OPTIMIZATION = contextOptimizationMd.trim();

/**
 * Get CLI guidelines by context/stage
 */
export const CLIGuidelines = {
	// Core rules - always needed
	core: CLI_CORE_RULES,

	// Commands reference
	commands: CLI_COMMANDS_REFERENCE,

	// Workflow stages
	workflow: {
		creation: CLI_WORKFLOW_CREATION,
		execution: CLI_WORKFLOW_EXECUTION,
		completion: CLI_WORKFLOW_COMPLETION,
	},

	// Common mistakes
	mistakes: CLI_COMMON_MISTAKES,

	// Context optimization
	contextOptimization: CLI_CONTEXT_OPTIMIZATION,

	/**
	 * Get full CLI guidelines (all sections combined)
	 */
	getFull(withMarkers = false): string {
		const content = [
			CLI_CORE_RULES,
			"---",
			CLI_CONTEXT_OPTIMIZATION,
			"---",
			CLI_COMMANDS_REFERENCE,
			"---",
			CLI_WORKFLOW_CREATION,
			"---",
			CLI_WORKFLOW_EXECUTION,
			"---",
			CLI_WORKFLOW_COMPLETION,
			"---",
			CLI_COMMON_MISTAKES,
		].join("\n\n");

		if (withMarkers) {
			return `<!-- KNOWNS GUIDELINES START -->\n${content}\n<!-- KNOWNS GUIDELINES END -->`;
		}
		return content;
	},

	/**
	 * Get compact CLI guidelines (core + context optimization + mistakes only)
	 */
	getCompact(): string {
		return [CLI_CORE_RULES, "---", CLI_CONTEXT_OPTIMIZATION, "---", CLI_COMMON_MISTAKES].join("\n\n");
	},

	/**
	 * Get CLI guidelines for specific workflow stage
	 */
	getForStage(stage: "creation" | "execution" | "completion"): string {
		const sections = [CLI_CORE_RULES, "---", CLI_CONTEXT_OPTIMIZATION, "---"];

		switch (stage) {
			case "creation":
				sections.push(CLI_WORKFLOW_CREATION);
				break;
			case "execution":
				sections.push(CLI_WORKFLOW_EXECUTION);
				sections.push("---", CLI_COMMANDS_REFERENCE);
				break;
			case "completion":
				sections.push(CLI_WORKFLOW_COMPLETION);
				break;
		}

		sections.push("---", CLI_COMMON_MISTAKES);
		return sections.join("\n\n");
	},
};

export default CLIGuidelines;
