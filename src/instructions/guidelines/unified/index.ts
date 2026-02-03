/**
 * Unified Guidelines Module
 *
 * Single source of truth for both CLI and MCP guidelines.
 * Uses Handlebars conditionals ({{#if mcp}}) for variant-specific content.
 */

import { renderString } from "../../../codegen/renderer";

// Import unified templates
import commandsReferenceMd from "./commands-reference.md";
import commonMistakesMd from "./common-mistakes.md";
import contextOptimizationMd from "./context-optimization.md";
import coreRulesMd from "./core-rules.md";
import workflowCompletionMd from "./workflow-completion.md";
import workflowCreationMd from "./workflow-creation.md";
import workflowExecutionMd from "./workflow-execution.md";

type Mode = "cli" | "mcp" | "unified";

/**
 * Render a template with the given mode
 */
function render(template: string, mode: Mode): string {
	return renderString(template, {
		mcp: mode === "mcp" || mode === "unified",
		cli: mode === "cli" || mode === "unified",
	}).trim();
}

/**
 * Create a Guidelines object for the given mode
 */
function createGuidelines(mode: Mode) {
	const core = render(coreRulesMd, mode);
	const commands = render(commandsReferenceMd, mode);
	const workflowCreation = render(workflowCreationMd, mode);
	const workflowExecution = render(workflowExecutionMd, mode);
	const workflowCompletion = render(workflowCompletionMd, mode);
	const mistakes = render(commonMistakesMd, mode);
	const contextOptimization = render(contextOptimizationMd, mode);

	return {
		core,
		commands,
		workflow: {
			creation: workflowCreation,
			execution: workflowExecution,
			completion: workflowCompletion,
		},
		mistakes,
		contextOptimization,

		getFull(withMarkers = false): string {
			const content = [
				core,
				"---",
				contextOptimization,
				"---",
				commands,
				"---",
				workflowCreation,
				"---",
				workflowExecution,
				"---",
				workflowCompletion,
				"---",
				mistakes,
			].join("\n\n");

			if (withMarkers) {
				return `<!-- KNOWNS GUIDELINES START -->\n${content}\n<!-- KNOWNS GUIDELINES END -->`;
			}
			return content;
		},

		getCompact(): string {
			return [core, "---", contextOptimization, "---", mistakes].join("\n\n");
		},

		getForStage(stage: "creation" | "execution" | "completion"): string {
			const sections = [core, "---", contextOptimization, "---"];

			switch (stage) {
				case "creation":
					sections.push(workflowCreation);
					break;
				case "execution":
					sections.push(workflowExecution);
					sections.push("---", commands);
					break;
				case "completion":
					sections.push(workflowCompletion);
					break;
			}

			sections.push("---", mistakes);
			return sections.join("\n\n");
		},
	};
}

// Export all variants
export const CLIGuidelines = createGuidelines("cli");
export const MCPGuidelines = createGuidelines("mcp");
export const UnifiedGuidelines = createGuidelines("unified");

// Default export
export const Guidelines = CLIGuidelines;
export default Guidelines;
