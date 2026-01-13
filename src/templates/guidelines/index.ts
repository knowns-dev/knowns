/**
 * Knowns Guidelines Module
 *
 * Modular guidelines for AI agents using Knowns CLI/MCP.
 * Each guideline focuses on a specific aspect of the workflow.
 */

// Core rules and principles
import coreRulesMd from "./core-rules.md";

// Complete CLI/MCP commands reference
import commandsReferenceMd from "./commands-reference.md";

import workflowCompletionMd from "./workflow-completion.md";
// Workflow stages
import workflowCreationMd from "./workflow-creation.md";
import workflowExecutionMd from "./workflow-execution.md";

// Anti-patterns and common mistakes
import commonMistakesMd from "./common-mistakes.md";

// Context optimization for AI agents
import contextOptimizationMd from "./context-optimization.md";

// Export individual guidelines (trimmed)
export const CORE_RULES = coreRulesMd.trim();
export const COMMANDS_REFERENCE = commandsReferenceMd.trim();
export const WORKFLOW_CREATION = workflowCreationMd.trim();
export const WORKFLOW_EXECUTION = workflowExecutionMd.trim();
export const WORKFLOW_COMPLETION = workflowCompletionMd.trim();
export const COMMON_MISTAKES = commonMistakesMd.trim();
export const CONTEXT_OPTIMIZATION = contextOptimizationMd.trim();

/**
 * Get guidelines by context/stage
 */
export const Guidelines = {
	// Core rules - always needed
	core: CORE_RULES,

	// Commands reference
	commands: COMMANDS_REFERENCE,

	// Workflow stages
	workflow: {
		creation: WORKFLOW_CREATION,
		execution: WORKFLOW_EXECUTION,
		completion: WORKFLOW_COMPLETION,
	},

	// Common mistakes
	mistakes: COMMON_MISTAKES,

	// Context optimization
	contextOptimization: CONTEXT_OPTIMIZATION,

	/**
	 * Get full guidelines (all sections combined)
	 */
	getFull(withMarkers = false): string {
		const content = [
			CORE_RULES,
			"---",
			CONTEXT_OPTIMIZATION,
			"---",
			COMMANDS_REFERENCE,
			"---",
			WORKFLOW_CREATION,
			"---",
			WORKFLOW_EXECUTION,
			"---",
			WORKFLOW_COMPLETION,
			"---",
			COMMON_MISTAKES,
		].join("\n\n");

		if (withMarkers) {
			return `<!-- KNOWNS GUIDELINES START -->\n${content}\n<!-- KNOWNS GUIDELINES END -->`;
		}
		return content;
	},

	/**
	 * Get compact guidelines (core + context optimization + mistakes only)
	 */
	getCompact(): string {
		return [CORE_RULES, "---", CONTEXT_OPTIMIZATION, "---", COMMON_MISTAKES].join("\n\n");
	},

	/**
	 * Get guidelines for specific workflow stage
	 */
	getForStage(stage: "creation" | "execution" | "completion"): string {
		const sections = [CORE_RULES, "---", CONTEXT_OPTIMIZATION, "---"];

		switch (stage) {
			case "creation":
				sections.push(WORKFLOW_CREATION);
				break;
			case "execution":
				sections.push(WORKFLOW_EXECUTION);
				sections.push("---", COMMANDS_REFERENCE);
				break;
			case "completion":
				sections.push(WORKFLOW_COMPLETION);
				break;
		}

		sections.push("---", COMMON_MISTAKES);
		return sections.join("\n\n");
	},
};

export default Guidelines;
