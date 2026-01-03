import type { Block } from "@blocknote/core";

// Use unknown for inline content to avoid complex generic type issues
type InlineContentItem = {
	type: string;
	text?: string;
	props?: Record<string, unknown>;
	styles?: Record<string, boolean>;
	content?: InlineContentItem[];
	href?: string;
};

// Table content structure - cells can be arrays or objects with content
type TableCell = InlineContentItem[] | { content: InlineContentItem[] };
type TableRow = { cells: TableCell[] };
type TableContent = {
	type: "tableContent";
	rows: TableRow[];
};

// Regex patterns for mentions in markdown (input format)
const TASK_MENTION_REGEX = /@(task-\d+(?:\.\d+)?)/g;
const DOC_MENTION_REGEX = /@docs?\/([^\s,;:!?"'()[\]]+)/g;

// Regex patterns for output format (need to normalize back to input format when loading)
// Matches: @.knowns/tasks/task-55 - Title.md or @.knowns/tasks/task-55.md
const OUTPUT_TASK_REGEX = /@\.knowns\/tasks\/task-(\d+(?:\.\d+)?)(?:\s*-\s*[^@\n]+?\.md|\.md)/g;
// Matches: @.knowns/docs/path/to/doc.md or @.knowns/docs/README.md - Description
const OUTPUT_DOC_REGEX = /@\.knowns\/docs\/([^\s@]+?)\.md(?:\s*-\s*[^@\n]+)?/g;

// Placeholder format for preserving mentions during parsing
const TASK_PLACEHOLDER_PREFIX = "[[TASK_MENTION:";
const DOC_PLACEHOLDER_PREFIX = "[[DOC_MENTION:";
const PLACEHOLDER_SUFFIX = "]]";

// Placeholder for code blocks and inline code (to skip mention processing inside them)
const CODE_BLOCK_PLACEHOLDER_PREFIX = "[[CODE_BLOCK:";
const INLINE_CODE_PLACEHOLDER_PREFIX = "[[INLINE_CODE:";
const CODE_PLACEHOLDER_SUFFIX = "]]";

/**
 * Normalize output format refs to input format
 * @.knowns/tasks/task-X - Title.md → @task-X
 * @.knowns/docs/path.md → @doc/path
 */
function normalizeOutputFormat(markdown: string): string {
	let result = markdown;

	// Normalize task refs: @.knowns/tasks/task-{id} - Title.md → @task-{id}
	result = result.replace(OUTPUT_TASK_REGEX, (_match, taskId) => `@task-${taskId}`);

	// Normalize doc refs: @.knowns/docs/{path}.md → @doc/{path}
	result = result.replace(OUTPUT_DOC_REGEX, (_match, docPath) => `@doc/${docPath}`);

	return result;
}

/**
 * Preprocess markdown to convert @mentions to placeholders
 * This ensures mentions are preserved during tryParseMarkdownToBlocks
 * Also handles output format (@.knowns/...) by normalizing first
 * Skips mentions inside code blocks and inline code
 */
export function preprocessMarkdown(markdown: string): string {
	// First normalize any output format refs to input format
	let processed = normalizeOutputFormat(markdown);

	// Step 1: Extract code blocks and inline code to protect them from mention processing
	const codeBlocks: string[] = [];
	const inlineCodes: string[] = [];

	// Extract fenced code blocks (``` ... ```)
	processed = processed.replace(/```[\s\S]*?```/g, (match) => {
		const index = codeBlocks.length;
		codeBlocks.push(match);
		return `${CODE_BLOCK_PLACEHOLDER_PREFIX}${index}${CODE_PLACEHOLDER_SUFFIX}`;
	});

	// Extract inline code (` ... `) - but not inside already extracted code blocks
	processed = processed.replace(/`[^`\n]+`/g, (match) => {
		const index = inlineCodes.length;
		inlineCodes.push(match);
		return `${INLINE_CODE_PLACEHOLDER_PREFIX}${index}${CODE_PLACEHOLDER_SUFFIX}`;
	});

	// Step 2: Convert @task-X to placeholder (only in non-code areas now)
	processed = processed.replace(TASK_MENTION_REGEX, (_match, taskId) => {
		return `${TASK_PLACEHOLDER_PREFIX}${taskId}${PLACEHOLDER_SUFFIX}`;
	});

	// Convert @doc/path to placeholder
	processed = processed.replace(DOC_MENTION_REGEX, (_match, docPath) => {
		// Strip trailing dot if not part of extension
		let cleanPath = docPath;
		if (cleanPath.endsWith(".") && !cleanPath.match(/\.\w+$/)) {
			cleanPath = cleanPath.slice(0, -1);
		}
		return `${DOC_PLACEHOLDER_PREFIX}${cleanPath}${PLACEHOLDER_SUFFIX}`;
	});

	// Step 3: Restore inline codes
	processed = processed.replace(
		new RegExp(`${escapeRegex(INLINE_CODE_PLACEHOLDER_PREFIX)}(\\d+)${escapeRegex(CODE_PLACEHOLDER_SUFFIX)}`, "g"),
		(_match, index) => inlineCodes[Number.parseInt(index, 10)],
	);

	// Step 4: Restore code blocks
	processed = processed.replace(
		new RegExp(`${escapeRegex(CODE_BLOCK_PLACEHOLDER_PREFIX)}(\\d+)${escapeRegex(CODE_PLACEHOLDER_SUFFIX)}`, "g"),
		(_match, index) => codeBlocks[Number.parseInt(index, 10)],
	);

	return processed;
}

/**
 * Postprocess blocks to convert placeholders back to mention inline content
 */
export function postprocessBlocks(blocks: Block[]): Block[] {
	return blocks.map((block) => processBlock(block));
}

function processBlock(block: Block): Block {
	// Process children blocks recursively
	const processedChildren = block.children?.map((child) => processBlock(child as Block)) || [];

	// Handle table content specially
	if (block.type === "table" && isTableContent(block.content)) {
		const processedContent = processTableContent(block.content);
		return {
			...block,
			content: processedContent as typeof block.content,
			children: processedChildren,
		} as Block;
	}

	// Process content if it exists and is an array
	const processedContent = Array.isArray(block.content)
		? processInlineContent(block.content as InlineContentItem[])
		: block.content;

	return {
		...block,
		content: processedContent as typeof block.content,
		children: processedChildren,
	} as Block;
}

function isTableContent(content: unknown): content is TableContent {
	return (
		typeof content === "object" &&
		content !== null &&
		"type" in content &&
		(content as TableContent).type === "tableContent" &&
		"rows" in content &&
		Array.isArray((content as TableContent).rows)
	);
}

function getCellContent(cell: TableCell): InlineContentItem[] | null {
	if (Array.isArray(cell)) {
		return cell;
	}
	if (cell && typeof cell === "object" && "content" in cell && Array.isArray(cell.content)) {
		return cell.content;
	}
	return null;
}

function processTableContent(content: TableContent): TableContent {
	return {
		...content,
		rows: content.rows.map((row) => ({
			...row,
			cells: row.cells.map((cell) => {
				const cellContent = getCellContent(cell);
				if (cellContent) {
					const processed = processInlineContent(cellContent);
					// Return in the same format as input
					if (Array.isArray(cell)) {
						return processed;
					}
					return { ...cell, content: processed };
				}
				return cell;
			}),
		})),
	};
}

function processInlineContent(content: InlineContentItem[]): InlineContentItem[] {
	const result: InlineContentItem[] = [];

	for (const item of content) {
		if (item.type === "text" && typeof item.text === "string") {
			// Check if text contains placeholders
			const text = item.text;
			const parts = splitByPlaceholders(text);

			for (const part of parts) {
				if (part.type === "text") {
					if (part.value) {
						result.push({
							type: "text",
							text: part.value,
							styles: item.styles || {},
						});
					}
				} else if (part.type === "taskMention") {
					result.push({
						type: "taskMention",
						props: { taskId: part.value },
					});
				} else if (part.type === "docMention") {
					result.push({
						type: "docMention",
						props: { docPath: part.value },
					});
				}
			}
		} else if (item.type === "link") {
			// Process link content recursively
			result.push({
				...item,
				content: processInlineContent(item.content || []),
			});
		} else {
			result.push(item);
		}
	}

	return result;
}

interface TextPart {
	type: "text" | "taskMention" | "docMention";
	value: string;
}

function splitByPlaceholders(text: string): TextPart[] {
	const parts: TextPart[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		// Find next placeholder
		const taskIndex = remaining.indexOf(TASK_PLACEHOLDER_PREFIX);
		const docIndex = remaining.indexOf(DOC_PLACEHOLDER_PREFIX);

		let nextIndex = -1;
		let isTask = false;

		if (taskIndex >= 0 && (docIndex < 0 || taskIndex < docIndex)) {
			nextIndex = taskIndex;
			isTask = true;
		} else if (docIndex >= 0) {
			nextIndex = docIndex;
			isTask = false;
		}

		if (nextIndex < 0) {
			// No more placeholders
			if (remaining) {
				parts.push({ type: "text", value: remaining });
			}
			break;
		}

		// Add text before placeholder
		if (nextIndex > 0) {
			parts.push({ type: "text", value: remaining.slice(0, nextIndex) });
		}

		// Extract placeholder content
		const prefix = isTask ? TASK_PLACEHOLDER_PREFIX : DOC_PLACEHOLDER_PREFIX;
		const startContent = nextIndex + prefix.length;
		const endContent = remaining.indexOf(PLACEHOLDER_SUFFIX, startContent);

		if (endContent < 0) {
			// Malformed placeholder, treat as text
			parts.push({ type: "text", value: remaining.slice(nextIndex) });
			break;
		}

		const value = remaining.slice(startContent, endContent);
		parts.push({
			type: isTask ? "taskMention" : "docMention",
			value,
		});

		remaining = remaining.slice(endContent + PLACEHOLDER_SUFFIX.length);
	}

	return parts;
}

/**
 * Prepare blocks for markdown serialization by replacing mentions with placeholders
 * This ensures mentions are properly serialized to markdown format
 */
export function prepareBlocksForSerialization(blocks: Block[]): Block[] {
	return blocks.map((block) => prepareBlockForSerialization(block));
}

function prepareBlockForSerialization(block: Block): Block {
	// Process children blocks recursively
	const processedChildren = block.children?.map((child) => prepareBlockForSerialization(child as Block)) || [];

	// Handle table content specially
	if (block.type === "table" && isTableContent(block.content)) {
		const processedContent = prepareTableContentForSerialization(block.content);
		return {
			...block,
			content: processedContent as typeof block.content,
			children: processedChildren,
		} as Block;
	}

	// Process content if it exists and is an array
	const processedContent = Array.isArray(block.content)
		? replaceMentionsWithPlaceholders(block.content as InlineContentItem[])
		: block.content;

	return {
		...block,
		content: processedContent as typeof block.content,
		children: processedChildren,
	} as Block;
}

function prepareTableContentForSerialization(content: TableContent): TableContent {
	return {
		...content,
		rows: content.rows.map((row) => ({
			...row,
			cells: row.cells.map((cell) => {
				const cellContent = getCellContent(cell);
				if (cellContent) {
					const processed = replaceMentionsWithPlaceholders(cellContent);
					// Return in the same format as input
					if (Array.isArray(cell)) {
						return processed;
					}
					return { ...cell, content: processed };
				}
				return cell;
			}),
		})),
	};
}

function replaceMentionsWithPlaceholders(content: InlineContentItem[]): InlineContentItem[] {
	const result: InlineContentItem[] = [];

	for (const item of content) {
		if (item.type === "taskMention") {
			const taskId = item.props?.taskId as string | undefined;
			if (taskId) {
				// Replace with placeholder text that will be converted to @task-X
				result.push({
					type: "text",
					text: `${TASK_PLACEHOLDER_PREFIX}${taskId}${PLACEHOLDER_SUFFIX}`,
					styles: {},
				});
			}
		} else if (item.type === "docMention") {
			const docPath = item.props?.docPath as string | undefined;
			if (docPath) {
				// Replace with placeholder text that will be converted to @doc/path
				result.push({
					type: "text",
					text: `${DOC_PLACEHOLDER_PREFIX}${docPath}${PLACEHOLDER_SUFFIX}`,
					styles: {},
				});
			}
		} else if (item.type === "link") {
			// Process link content recursively
			result.push({
				...item,
				content: replaceMentionsWithPlaceholders(item.content || []),
			});
		} else {
			result.push(item);
		}
	}

	return result;
}

/**
 * Serialize blocks back to markdown, converting mentions to @format
 */
export function serializeMentionsInMarkdown(markdown: string, _blocks: Block[]): string {
	let result = markdown;

	// Replace placeholders with proper @ format
	result = result.replace(
		new RegExp(`${escapeRegex(TASK_PLACEHOLDER_PREFIX)}([^\\]]+)${escapeRegex(PLACEHOLDER_SUFFIX)}`, "g"),
		"@$1",
	);

	result = result.replace(
		new RegExp(`${escapeRegex(DOC_PLACEHOLDER_PREFIX)}([^\\]]+)${escapeRegex(PLACEHOLDER_SUFFIX)}`, "g"),
		"@doc/$1",
	);

	return result;
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract mentions from blocks and convert to markdown format
 */
export function blocksToMentionMarkdown(blocks: Block[]): string {
	const mentions: string[] = [];

	function extractFromInlineContent(content: InlineContentItem[]) {
		for (const item of content) {
			if (item.type === "taskMention") {
				const taskId = item.props?.taskId as string | undefined;
				if (taskId) {
					mentions.push(`@${taskId}`);
				}
			} else if (item.type === "docMention") {
				const docPath = item.props?.docPath as string | undefined;
				if (docPath) {
					mentions.push(`@doc/${docPath}`);
				}
			}
		}
	}

	function extractFromBlock(block: Block) {
		// Handle table content specially
		if (block.type === "table" && isTableContent(block.content)) {
			for (const row of block.content.rows) {
				for (const cell of row.cells) {
					const cellContent = getCellContent(cell);
					if (cellContent) {
						extractFromInlineContent(cellContent);
					}
				}
			}
		} else if (Array.isArray(block.content)) {
			extractFromInlineContent(block.content as InlineContentItem[]);
		}

		if (block.children) {
			for (const child of block.children) {
				extractFromBlock(child as Block);
			}
		}
	}

	for (const block of blocks) {
		extractFromBlock(block);
	}

	return mentions.join(" ");
}
