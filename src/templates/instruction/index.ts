/**
 * Instruction Templates Module
 *
 * Minimal instruction templates that tell AI to call guideline command.
 * Markers are added programmatically when exported.
 */

import cliTemplate from "./cli.md";
import mcpTemplate from "./mcp.md";

const START_MARKER = "<!-- KNOWNS GUIDELINES START -->";
const END_MARKER = "<!-- KNOWNS GUIDELINES END -->";

/**
 * Wrap template content with guideline markers
 */
function withMarkers(template: string): string {
	return `${START_MARKER}\n${template.trim()}\n${END_MARKER}`;
}

// Export raw templates (without markers)
export const CLI_TEMPLATE_RAW = cliTemplate.trim();
export const MCP_TEMPLATE_RAW = mcpTemplate.trim();

// Export templates with markers (for sync command)
export const CLI_INSTRUCTION = withMarkers(cliTemplate);
export const MCP_INSTRUCTION = withMarkers(mcpTemplate);

// Export utility
export { withMarkers, START_MARKER, END_MARKER };

export default {
	cli: CLI_INSTRUCTION,
	mcp: MCP_INSTRUCTION,
	raw: {
		cli: CLI_TEMPLATE_RAW,
		mcp: MCP_TEMPLATE_RAW,
	},
	withMarkers,
};
