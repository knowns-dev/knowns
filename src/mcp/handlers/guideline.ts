/**
 * MCP Handler for Guidelines
 * Provides AI agents with usage guidelines on-demand
 */

import { z } from "zod";
// Import modular guidelines (CLI and MCP variants)
import { Guidelines, MCPGuidelines } from "../../templates/guidelines";

export const getGuidelineSchema = z.object({
	type: z.enum(["unified", "cli", "mcp"]).optional().default("unified"),
});

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

	// Return type-specific guidelines
	let guidelines: string;
	switch (input.type) {
		case "mcp":
			guidelines = MCPGuidelines.getFull();
			break;
		case "cli":
			guidelines = Guidelines.getFull();
			break;
		default:
			// For unified or unspecified, return MCP guidelines since this is called via MCP
			guidelines = MCPGuidelines.getFull();
			break;
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
