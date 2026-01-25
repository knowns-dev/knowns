/**
 * Knowns Guidelines Module
 *
 * Unified guidelines for AI agents using Knowns CLI/MCP.
 * Uses Handlebars conditionals for CLI/MCP variants.
 */

// Import from unified source
import { CLIGuidelines, Guidelines, MCPGuidelines } from "./unified";

// Re-export both variants
export { CLIGuidelines, MCPGuidelines, Guidelines };

// Re-export individual CLI constants for backwards compatibility
export const CORE_RULES = CLIGuidelines.core;
export const COMMANDS_REFERENCE = CLIGuidelines.commands;
export const WORKFLOW_CREATION = CLIGuidelines.workflow.creation;
export const WORKFLOW_EXECUTION = CLIGuidelines.workflow.execution;
export const WORKFLOW_COMPLETION = CLIGuidelines.workflow.completion;
export const COMMON_MISTAKES = CLIGuidelines.mistakes;
export const CONTEXT_OPTIMIZATION = CLIGuidelines.contextOptimization;

export default Guidelines;
