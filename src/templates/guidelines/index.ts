/**
 * Knowns Guidelines Module
 *
 * Modular guidelines for AI agents using Knowns CLI/MCP.
 * Each guideline focuses on a specific aspect of the workflow.
 *
 * Two variants available:
 * - CLI Guidelines: For agents using `knowns` CLI commands (./cli/)
 * - MCP Guidelines: For agents using MCP tools mcp__knowns__* (./mcp/)
 */

// Import from organized subdirectories
import { CLIGuidelines } from "./cli";
import { MCPGuidelines } from "./mcp";

// Re-export both variants
export { CLIGuidelines, MCPGuidelines };

// Export CLI as default Guidelines for backwards compatibility
export const Guidelines = CLIGuidelines;

// Re-export individual CLI constants for backwards compatibility
export const CORE_RULES = CLIGuidelines.core;
export const COMMANDS_REFERENCE = CLIGuidelines.commands;
export const WORKFLOW_CREATION = CLIGuidelines.workflow.creation;
export const WORKFLOW_EXECUTION = CLIGuidelines.workflow.execution;
export const WORKFLOW_COMPLETION = CLIGuidelines.workflow.completion;
export const COMMON_MISTAKES = CLIGuidelines.mistakes;
export const CONTEXT_OPTIMIZATION = CLIGuidelines.contextOptimization;

export default Guidelines;
