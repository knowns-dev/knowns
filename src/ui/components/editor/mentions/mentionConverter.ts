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

// Regex patterns for mentions in markdown
const TASK_MENTION_REGEX = /@(task-\d+(?:\.\d+)?)/g;
const DOC_MENTION_REGEX = /@docs?\/([^\s,;:!?"'()[\]]+)/g;

// Placeholder format for preserving mentions during parsing
const TASK_PLACEHOLDER_PREFIX = "[[TASK_MENTION:";
const DOC_PLACEHOLDER_PREFIX = "[[DOC_MENTION:";
const PLACEHOLDER_SUFFIX = "]]";

/**
 * Preprocess markdown to convert @mentions to placeholders
 * This ensures mentions are preserved during tryParseMarkdownToBlocks
 */
export function preprocessMarkdown(markdown: string): string {
	let processed = markdown;

	// Convert @task-X to placeholder
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
 * Serialize blocks back to markdown, converting mentions to @format
 */
export function serializeMentionsInMarkdown(markdown: string, blocks: Block[]): string {
	// The blocksToMarkdownLossy will output mentions as text
	// We need to ensure our custom inline content is properly serialized

	// For now, we rely on the blocks containing the right format
	// and manually replace any mention placeholders that might remain
	let result = markdown;

	// Replace any remaining placeholders with proper @ format
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

	function extractFromBlock(block: Block) {
		if (Array.isArray(block.content)) {
			for (const item of block.content as InlineContentItem[]) {
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
