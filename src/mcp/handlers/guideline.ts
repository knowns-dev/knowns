/**
 * MCP Handler for Guidelines
 * Provides AI agents with usage guidelines on-demand
 */

import { z } from "zod";
// Import markdown templates (esbuild loader: "text")
import CLI_GENERAL from "../../templates/cli/general.md";
import MCP_GENERAL from "../../templates/mcp/general.md";
import UNIFIED_GUIDELINES from "../../templates/unified.md";

export const getGuidelineSchema = z.object({
	type: z.enum(["unified", "cli", "mcp"]).optional().default("unified"),
});

/**
 * Strip marker comments from guidelines
 */
function stripMarkers(content: string): string {
	return content
		.replace(/<!-- KNOWNS GUIDELINES START -->\n?/g, "")
		.replace(/<!-- KNOWNS GUIDELINES END -->\n?/g, "")
		.trim();
}

// Tool definition
export const guidelineTools = [
	{
		name: "get_guideline",
		description:
			"Get usage guidelines for Knowns CLI/MCP. Call this at session start to understand how to use the tools correctly.",
		inputSchema: {
			type: "object",
			properties: {
				type: {
					type: "string",
					enum: ["unified", "cli", "mcp"],
					description: "Type of guidelines: unified (default, covers both), cli (CLI only), mcp (MCP only)",
				},
			},
		},
	},
];

/**
 * Handle get_guideline tool call
 */
export async function handleGetGuideline(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
	const input = getGuidelineSchema.parse(args || {});

	let guidelines: string;
	switch (input.type) {
		case "cli":
			guidelines = stripMarkers(CLI_GENERAL);
			break;
		case "mcp":
			guidelines = stripMarkers(MCP_GENERAL);
			break;
		default:
			guidelines = UNIFIED_GUIDELINES;
	}

	return {
		content: [
			{
				type: "text",
				text: guidelines,
			},
		],
	};
}
