/**
 * Knowns MCP Guidelines Module
 *
 * MCP-specific guidelines for AI agents using Knowns MCP tools.
 */

import commandsReferenceMd from "./commands-reference.md";
import commonMistakesMd from "./common-mistakes.md";
import contextOptimizationMd from "./context-optimization.md";
// MCP-specific guidelines
import coreRulesMd from "./core-rules.md";
import workflowCompletionMd from "./workflow-completion.md";
import workflowCreationMd from "./workflow-creation.md";
import workflowExecutionMd from "./workflow-execution.md";

// Export individual guidelines (trimmed)
export const MCP_CORE_RULES = coreRulesMd.trim();
export const MCP_COMMANDS_REFERENCE = commandsReferenceMd.trim();
export const MCP_WORKFLOW_CREATION = workflowCreationMd.trim();
export const MCP_WORKFLOW_EXECUTION = workflowExecutionMd.trim();
export const MCP_WORKFLOW_COMPLETION = workflowCompletionMd.trim();
export const MCP_COMMON_MISTAKES = commonMistakesMd.trim();
export const MCP_CONTEXT_OPTIMIZATION = contextOptimizationMd.trim();

/**
 * Get MCP guidelines by context/stage
 */
export const MCPGuidelines = {
	// Core rules - always needed
	core: MCP_CORE_RULES,

	// Commands reference
	commands: MCP_COMMANDS_REFERENCE,

	// Workflow stages
	workflow: {
		creation: MCP_WORKFLOW_CREATION,
		execution: MCP_WORKFLOW_EXECUTION,
		completion: MCP_WORKFLOW_COMPLETION,
	},

	// Common mistakes
	mistakes: MCP_COMMON_MISTAKES,

	// Context optimization
	contextOptimization: MCP_CONTEXT_OPTIMIZATION,

	/**
	 * Get full MCP guidelines (all sections combined)
	 */
	getFull(withMarkers = false): string {
		const content = [
			MCP_CORE_RULES,
			"---",
			MCP_CONTEXT_OPTIMIZATION,
			"---",
			MCP_COMMANDS_REFERENCE,
			"---",
			MCP_WORKFLOW_CREATION,
			"---",
			MCP_WORKFLOW_EXECUTION,
			"---",
			MCP_WORKFLOW_COMPLETION,
			"---",
			MCP_COMMON_MISTAKES,
		].join("\n\n");

		if (withMarkers) {
			return `<!-- KNOWNS GUIDELINES START -->\n${content}\n<!-- KNOWNS GUIDELINES END -->`;
		}
		return content;
	},

	/**
	 * Get compact MCP guidelines (core + context optimization + mistakes only)
	 */
	getCompact(): string {
		return [MCP_CORE_RULES, "---", MCP_CONTEXT_OPTIMIZATION, "---", MCP_COMMON_MISTAKES].join("\n\n");
	},

	/**
	 * Get MCP guidelines for specific workflow stage
	 */
	getForStage(stage: "creation" | "execution" | "completion"): string {
		const sections = [MCP_CORE_RULES, "---", MCP_CONTEXT_OPTIMIZATION, "---"];

		switch (stage) {
			case "creation":
				sections.push(MCP_WORKFLOW_CREATION);
				break;
			case "execution":
				sections.push(MCP_WORKFLOW_EXECUTION);
				sections.push("---", MCP_COMMANDS_REFERENCE);
				break;
			case "completion":
				sections.push(MCP_WORKFLOW_COMPLETION);
				break;
		}

		sections.push("---", MCP_COMMON_MISTAKES);
		return sections.join("\n\n");
	},
};

export default MCPGuidelines;
