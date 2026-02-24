/**
 * Chunker
 * Split documents and tasks into semantic chunks for embedding
 */

import type { Task } from "@models/task";
import type {
	Chunk,
	ChunkResult,
	DocChunk,
	DocMetadata,
	EmbeddingModel,
	MarkdownHeading,
	TaskChunk,
	TaskChunkableField,
} from "./types";
import { EMBEDDING_MODELS, getTaskFieldContent } from "./types";

/**
 * Simple token estimation (approx 4 chars per token for English)
 * This is a rough estimate - actual tokenization depends on the model
 */
export function estimateTokens(text: string): number {
	if (!text) return 0;
	// Rough estimate: ~4 characters per token for English text
	// This is conservative to avoid exceeding limits
	return Math.ceil(text.length / 4);
}

/**
 * Extract headings from markdown content
 */
export function extractHeadings(markdown: string): MarkdownHeading[] {
	const headings: MarkdownHeading[] = [];
	const lines = markdown.split("\n");

	let currentHeading: MarkdownHeading | null = null;
	let contentStartIndex = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

		if (headingMatch) {
			// Save previous heading with its content
			if (currentHeading) {
				const contentEndIndex = lines.slice(0, i).join("\n").length;
				currentHeading.content = markdown.substring(currentHeading.startIndex, contentEndIndex).trim();
				currentHeading.endIndex = contentEndIndex;
				headings.push(currentHeading);
			}

			// Start new heading
			const level = headingMatch[1].length;
			const title = headingMatch[2].trim();
			contentStartIndex = lines.slice(0, i).join("\n").length + line.length + 1;

			currentHeading = {
				level,
				title,
				content: "",
				startIndex: contentStartIndex,
				endIndex: markdown.length,
			};
		}
	}

	// Don't forget the last heading
	if (currentHeading) {
		currentHeading.content = markdown.substring(currentHeading.startIndex).trim();
		currentHeading.endIndex = markdown.length;
		headings.push(currentHeading);
	}

	return headings;
}

/**
 * Chunk a document by headings
 */
export function chunkDocument(
	content: string,
	metadata: DocMetadata,
	model: EmbeddingModel = "gte-small",
): ChunkResult {
	const modelConfig = EMBEDDING_MODELS[model];
	const maxTokens = modelConfig.maxTokens;
	const chunks: DocChunk[] = [];
	let totalTokens = 0;

	// First chunk: metadata (title + description)
	const metadataContent = metadata.description ? `${metadata.title}\n\n${metadata.description}` : metadata.title;

	const metadataTokens = estimateTokens(metadataContent);
	chunks.push({
		id: `doc:${metadata.path}:chunk:0`,
		type: "doc",
		docPath: metadata.path,
		section: "# Metadata",
		content: metadataContent,
		tokenCount: metadataTokens,
		metadata: {
			headingLevel: 1,
			position: 0,
		},
	});
	totalTokens += metadataTokens;

	// Extract headings and create chunks
	const headings = extractHeadings(content);

	// Group ## headings as main chunks, ### as sub-chunks
	let position = 1;
	let parentSection: string | undefined;

	for (const heading of headings) {
		// Skip h1 (usually document title, already in metadata)
		if (heading.level === 1) continue;

		const sectionTitle = `${"#".repeat(heading.level)} ${heading.title}`;
		const sectionContent = `${sectionTitle}\n\n${heading.content}`;
		const tokenCount = estimateTokens(sectionContent);

		// If content exceeds max tokens, we need to split it
		if (tokenCount > maxTokens) {
			// Split by paragraphs
			const paragraphs = heading.content.split(/\n\n+/);
			let currentChunkContent = sectionTitle;
			let currentTokenCount = estimateTokens(sectionTitle);

			for (const para of paragraphs) {
				const paraTokens = estimateTokens(para);

				if (currentTokenCount + paraTokens > maxTokens && currentChunkContent !== sectionTitle) {
					// Save current chunk and start new one
					chunks.push({
						id: `doc:${metadata.path}:chunk:${position}`,
						type: "doc",
						docPath: metadata.path,
						section: sectionTitle,
						content: currentChunkContent,
						tokenCount: currentTokenCount,
						metadata: {
							headingLevel: heading.level,
							parentSection: heading.level > 2 ? parentSection : undefined,
							position,
						},
					});
					totalTokens += currentTokenCount;
					position++;

					// Start new chunk (continuation)
					currentChunkContent = `${sectionTitle} (continued)\n\n${para}`;
					currentTokenCount = estimateTokens(currentChunkContent);
				} else {
					currentChunkContent += `\n\n${para}`;
					currentTokenCount += paraTokens;
				}
			}

			// Don't forget remaining content
			if (currentChunkContent !== sectionTitle) {
				chunks.push({
					id: `doc:${metadata.path}:chunk:${position}`,
					type: "doc",
					docPath: metadata.path,
					section: sectionTitle,
					content: currentChunkContent,
					tokenCount: currentTokenCount,
					metadata: {
						headingLevel: heading.level,
						parentSection: heading.level > 2 ? parentSection : undefined,
						position,
					},
				});
				totalTokens += currentTokenCount;
				position++;
			}
		} else {
			// Content fits in one chunk
			chunks.push({
				id: `doc:${metadata.path}:chunk:${position}`,
				type: "doc",
				docPath: metadata.path,
				section: sectionTitle,
				content: sectionContent,
				tokenCount,
				metadata: {
					headingLevel: heading.level,
					parentSection: heading.level > 2 ? parentSection : undefined,
					position,
				},
			});
			totalTokens += tokenCount;
			position++;
		}

		// Track parent section for nested headings
		if (heading.level === 2) {
			parentSection = sectionTitle;
		}
	}

	// If no headings found, treat entire content as one chunk
	if (headings.length === 0 && content.trim()) {
		const contentTokens = estimateTokens(content);
		chunks.push({
			id: `doc:${metadata.path}:chunk:1`,
			type: "doc",
			docPath: metadata.path,
			section: "# Content",
			content: content,
			tokenCount: contentTokens,
			metadata: {
				headingLevel: 1,
				position: 1,
			},
		});
		totalTokens += contentTokens;
	}

	return { chunks, totalTokens };
}

/**
 * Chunk a task by fields
 */
export function chunkTask(task: Task, model: EmbeddingModel = "gte-small"): ChunkResult {
	const chunks: TaskChunk[] = [];
	let totalTokens = 0;

	const fields: TaskChunkableField[] = ["description", "ac", "plan", "notes"];

	for (const field of fields) {
		const content = getTaskFieldContent(task, field);
		if (!content) continue;

		const tokenCount = estimateTokens(content);

		chunks.push({
			id: `task:${task.id}:chunk:${field}`,
			type: "task",
			taskId: task.id,
			field,
			content,
			tokenCount,
			metadata: {
				status: task.status,
				priority: task.priority,
				labels: task.labels,
			},
		});

		totalTokens += tokenCount;
	}

	return { chunks, totalTokens };
}

/**
 * Get all chunkable content from a task as a single string
 * Useful for simple embedding without chunking
 */
export function getTaskSearchableContent(task: Task): string {
	const parts: string[] = [task.title];

	if (task.description) parts.push(task.description);

	if (task.acceptanceCriteria?.length) {
		parts.push(task.acceptanceCriteria.map((ac) => ac.text).join(" "));
	}

	if (task.implementationPlan) parts.push(task.implementationPlan);
	if (task.implementationNotes) parts.push(task.implementationNotes);

	return parts.join("\n\n");
}
