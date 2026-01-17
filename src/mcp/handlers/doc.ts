/**
 * Documentation management MCP handlers
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizePath } from "@utils/index";
import {
	calculateDocStats,
	extractSection,
	extractSectionByIndex,
	extractToc,
	formatToc,
	replaceSection,
	replaceSectionByIndex,
} from "@utils/markdown-toc";
import { notifyDocUpdate } from "@utils/notify-server";
import matter from "gray-matter";
import { z } from "zod";
import { errorResponse, successResponse } from "../utils";

const DOCS_DIR = join(process.cwd(), ".knowns", "docs");

// Document metadata interface
interface DocMetadata {
	title: string;
	description?: string;
	createdAt: string;
	updatedAt: string;
	tags?: string[];
}

// Schemas
export const listDocsSchema = z.object({
	tag: z.string().optional(),
});

export const getDocSchema = z.object({
	path: z.string(), // Document path (filename or folder/filename)
	info: z.boolean().optional(), // Return document stats (size, tokens, headings) without content
	toc: z.boolean().optional(), // Return table of contents only
	section: z.string().optional(), // Return specific section by heading title or number
	smart: z.boolean().optional(), // Smart mode: auto-return full content if small, or stats+TOC if large
});

export const createDocSchema = z.object({
	title: z.string(),
	description: z.string().optional(),
	content: z.string().optional(),
	tags: z.array(z.string()).optional(),
	folder: z.string().optional(), // Optional folder path
});

export const updateDocSchema = z.object({
	path: z.string(), // Document path
	title: z.string().optional(),
	description: z.string().optional(),
	content: z.string().optional(),
	tags: z.array(z.string()).optional(),
	appendContent: z.string().optional(), // Append to existing content
	section: z.string().optional(), // Target section to replace (use with content)
});

export const searchDocsSchema = z.object({
	query: z.string(),
	tag: z.string().optional(),
});

// Tool definitions
export const docTools = [
	{
		name: "list_docs",
		description: "List all documentation files with optional tag filter",
		inputSchema: {
			type: "object",
			properties: {
				tag: { type: "string", description: "Filter by tag" },
			},
		},
	},
	{
		name: "get_doc",
		description:
			"Get a documentation file by path. Use 'smart: true' for auto-optimized reading (recommended for AI), or 'info/toc/section' for manual control.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Document path (e.g., 'readme', 'guides/setup', 'conventions/naming.md')",
				},
				smart: {
					type: "boolean",
					description:
						"Smart mode (recommended): auto-return full content if small (≤2000 tokens), or stats+TOC if large. Use this by default.",
				},
				info: {
					type: "boolean",
					description:
						"Return document stats (size, tokens, headings) without content. Use this first to decide how to read.",
				},
				toc: {
					type: "boolean",
					description: "Return table of contents only (list of headings). Use this first for large documents.",
				},
				section: {
					type: "string",
					description:
						"Return specific section by heading title or number (e.g., '2. Overview' or '2'). Use after viewing TOC.",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "create_doc",
		description: "Create a new documentation file",
		inputSchema: {
			type: "object",
			properties: {
				title: { type: "string", description: "Document title" },
				description: { type: "string", description: "Document description" },
				content: { type: "string", description: "Initial content (markdown)" },
				tags: {
					type: "array",
					items: { type: "string" },
					description: "Document tags",
				},
				folder: {
					type: "string",
					description: "Folder path (e.g., 'guides', 'patterns/auth')",
				},
			},
			required: ["title"],
		},
	},
	{
		name: "update_doc",
		description:
			"Update an existing documentation file. Use 'section' with 'content' to replace only a specific section.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Document path (e.g., 'readme', 'guides/setup')",
				},
				title: { type: "string", description: "New title" },
				description: { type: "string", description: "New description" },
				content: {
					type: "string",
					description: "Replace content (or section content if 'section' is specified)",
				},
				tags: {
					type: "array",
					items: { type: "string" },
					description: "New tags",
				},
				appendContent: {
					type: "string",
					description: "Append to existing content",
				},
				section: {
					type: "string",
					description: "Target section to replace by heading title or number (use with 'content')",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "search_docs",
		description: "Search documentation by query string",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query" },
				tag: { type: "string", description: "Filter by tag" },
			},
			required: ["query"],
		},
	},
];

// Helper: Ensure docs directory exists
async function ensureDocsDir(): Promise<void> {
	if (!existsSync(DOCS_DIR)) {
		await mkdir(DOCS_DIR, { recursive: true });
	}
}

// Helper: Convert title to filename
function titleToFilename(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

// Helper: Recursively read all .md files in a directory
async function getAllMdFiles(dir: string, basePath = ""): Promise<string[]> {
	const files: string[] = [];

	if (!existsSync(dir)) {
		return files;
	}

	const entries = await readdir(dir, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		// Use forward slashes for cross-platform consistency (Windows uses backslash)
		const relativePath = normalizePath(basePath ? join(basePath, entry.name) : entry.name);

		if (entry.isDirectory()) {
			const subFiles = await getAllMdFiles(fullPath, relativePath);
			files.push(...subFiles);
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			files.push(relativePath);
		}
	}

	return files;
}

// Helper: Resolve doc path to filepath
async function resolveDocPath(name: string): Promise<{ filepath: string; filename: string } | null> {
	await ensureDocsDir();

	// Try multiple approaches to find the file
	let filename = name.endsWith(".md") ? name : `${name}.md`;
	let filepath = join(DOCS_DIR, filename);

	if (existsSync(filepath)) {
		return { filepath, filename };
	}

	// Try converting title to filename (root level only)
	filename = `${titleToFilename(name)}.md`;
	filepath = join(DOCS_DIR, filename);

	if (existsSync(filepath)) {
		return { filepath, filename };
	}

	// Try searching in all md files
	const allFiles = await getAllMdFiles(DOCS_DIR);
	const searchName = name.toLowerCase().replace(/\.md$/, "");

	const matchingFile = allFiles.find((file) => {
		const fileNameOnly = file.toLowerCase().replace(/\.md$/, "");
		const fileBaseName = file.split("/").pop()?.toLowerCase().replace(/\.md$/, "");
		return fileNameOnly === searchName || fileBaseName === searchName || file === name;
	});

	if (matchingFile) {
		return {
			filepath: join(DOCS_DIR, matchingFile),
			filename: matchingFile,
		};
	}

	return null;
}

// Handlers
export async function handleListDocs(args: unknown) {
	const input = listDocsSchema.parse(args);
	await ensureDocsDir();

	const mdFiles = await getAllMdFiles(DOCS_DIR);

	if (mdFiles.length === 0) {
		return successResponse({
			count: 0,
			docs: [],
			message: "No documentation files found",
		});
	}

	const docs: Array<{
		path: string;
		title: string;
		description?: string;
		tags?: string[];
		tokens: number;
		updatedAt: string;
	}> = [];

	for (const file of mdFiles) {
		const fileContent = await readFile(join(DOCS_DIR, file), "utf-8");
		const { data, content } = matter(fileContent);
		const metadata = data as DocMetadata;
		const stats = calculateDocStats(content);

		// Filter by tag if specified
		if (input.tag && !metadata.tags?.includes(input.tag)) {
			continue;
		}

		docs.push({
			path: file.replace(/\.md$/, ""),
			title: metadata.title || file.replace(/\.md$/, ""),
			description: metadata.description,
			tags: metadata.tags,
			tokens: stats.estimatedTokens,
			updatedAt: metadata.updatedAt,
		});
	}

	return successResponse({
		count: docs.length,
		docs,
	});
}

export async function handleGetDoc(args: unknown) {
	const input = getDocSchema.parse(args);
	const resolved = await resolveDocPath(input.path);

	if (!resolved) {
		return errorResponse(`Documentation not found: ${input.path}`);
	}

	const fileContent = await readFile(resolved.filepath, "utf-8");
	const { data, content } = matter(fileContent);
	const metadata = data as DocMetadata;

	// Handle --smart option: auto-decide based on document size
	if (input.smart) {
		const stats = calculateDocStats(content);
		const SMART_THRESHOLD = 2000; // tokens

		if (stats.estimatedTokens <= SMART_THRESHOLD) {
			// Small doc: return full content (fall through to default behavior at end)
		} else {
			// Large doc: return stats + TOC
			const toc = extractToc(content);
			return successResponse({
				doc: {
					path: resolved.filename.replace(/\.md$/, ""),
					title: metadata.title,
					smart: true,
					isLarge: true,
					stats: {
						chars: stats.chars,
						estimatedTokens: stats.estimatedTokens,
						headingCount: stats.headingCount,
					},
					toc: toc.map((entry, index) => ({
						index: index + 1,
						level: entry.level,
						title: entry.title,
					})),
					hint: "Document is large. Use 'section' parameter with a number (e.g., section: '1') to read specific content.",
				},
			});
		}
	}

	// Handle --info option: return document stats without content
	if (input.info) {
		const stats = calculateDocStats(content);
		let recommendation: string;
		if (stats.estimatedTokens > 4000) {
			recommendation = "Document is large. Use 'toc: true' first, then 'section' to read specific parts.";
		} else if (stats.estimatedTokens > 2000) {
			recommendation = "Consider using 'toc: true' and 'section' for specific info.";
		} else {
			recommendation = "Document is small enough to read directly.";
		}

		return successResponse({
			doc: {
				path: resolved.filename.replace(/\.md$/, ""),
				title: metadata.title,
				stats: {
					chars: stats.chars,
					words: stats.words,
					lines: stats.lines,
					estimatedTokens: stats.estimatedTokens,
					headingCount: stats.headingCount,
				},
				recommendation,
			},
		});
	}

	// Handle --toc option: return table of contents only
	if (input.toc) {
		const toc = extractToc(content);
		if (toc.length === 0) {
			return successResponse({
				doc: {
					path: resolved.filename.replace(/\.md$/, ""),
					title: metadata.title,
					toc: [],
					message: "No headings found in this document.",
				},
			});
		}

		return successResponse({
			doc: {
				path: resolved.filename.replace(/\.md$/, ""),
				title: metadata.title,
				toc: toc.map((entry, index) => ({
					index: index + 1,
					level: entry.level,
					title: entry.title,
				})),
				hint: "Use 'section' parameter with a heading title or number to read specific content.",
			},
		});
	}

	// Handle --section option: return specific section only
	if (input.section) {
		// Check if section is a pure number (index from TOC display)
		const sectionIndex = /^\d+$/.test(input.section) ? Number.parseInt(input.section, 10) : null;
		const sectionContent =
			sectionIndex !== null ? extractSectionByIndex(content, sectionIndex) : extractSection(content, input.section);
		if (!sectionContent) {
			return errorResponse(`Section not found: ${input.section}. Use 'toc: true' to see available sections.`);
		}

		return successResponse({
			doc: {
				path: resolved.filename.replace(/\.md$/, ""),
				title: metadata.title,
				section: input.section,
				content: sectionContent,
			},
		});
	}

	// Default: return full document
	return successResponse({
		doc: {
			path: resolved.filename.replace(/\.md$/, ""),
			title: metadata.title,
			description: metadata.description,
			tags: metadata.tags,
			createdAt: metadata.createdAt,
			updatedAt: metadata.updatedAt,
			content: content.trim(),
		},
	});
}

export async function handleCreateDoc(args: unknown) {
	const input = createDocSchema.parse(args);
	await ensureDocsDir();

	const filename = `${titleToFilename(input.title)}.md`;

	// Handle folder path
	let targetDir = DOCS_DIR;
	let relativePath = filename;

	if (input.folder) {
		const folderPath = input.folder.replace(/^\/|\/$/g, "");
		targetDir = join(DOCS_DIR, folderPath);
		relativePath = join(folderPath, filename);

		if (!existsSync(targetDir)) {
			await mkdir(targetDir, { recursive: true });
		}
	}

	const filepath = join(targetDir, filename);

	if (existsSync(filepath)) {
		return errorResponse(`Document already exists: ${relativePath}`);
	}

	const now = new Date().toISOString();
	const metadata: DocMetadata = {
		title: input.title,
		createdAt: now,
		updatedAt: now,
	};

	if (input.description) {
		metadata.description = input.description;
	}

	if (input.tags) {
		metadata.tags = input.tags;
	}

	const initialContent = input.content || "# Content\n\nWrite your documentation here.";
	const fileContent = matter.stringify(initialContent, metadata);

	await writeFile(filepath, fileContent, "utf-8");

	// Notify web server for real-time updates
	await notifyDocUpdate(relativePath);

	return successResponse({
		message: `Created documentation: ${relativePath}`,
		doc: {
			path: relativePath.replace(/\.md$/, ""),
			title: metadata.title,
			description: metadata.description,
			tags: metadata.tags,
		},
	});
}

export async function handleUpdateDoc(args: unknown) {
	const input = updateDocSchema.parse(args);
	const resolved = await resolveDocPath(input.path);

	if (!resolved) {
		return errorResponse(`Documentation not found: ${input.path}`);
	}

	const fileContent = await readFile(resolved.filepath, "utf-8");
	const { data, content } = matter(fileContent);
	const metadata = data as DocMetadata;

	// Update metadata
	if (input.title) metadata.title = input.title;
	if (input.description) metadata.description = input.description;
	if (input.tags) metadata.tags = input.tags;
	metadata.updatedAt = new Date().toISOString();

	// Update content
	let updatedContent = content;
	let sectionUpdated: string | undefined;

	// Handle section replacement
	if (input.section && input.content) {
		// Check if section is a pure number (index from TOC display)
		const sectionIndex = /^\d+$/.test(input.section) ? Number.parseInt(input.section, 10) : null;
		const result =
			sectionIndex !== null
				? replaceSectionByIndex(content, sectionIndex, input.content)
				: replaceSection(content, input.section, input.content);
		if (!result) {
			return errorResponse(
				`Section not found: ${input.section}. Use 'toc: true' with get_doc to see available sections.`,
			);
		}
		updatedContent = result;
		sectionUpdated = input.section;
	} else if (input.content) {
		updatedContent = input.content;
	}

	if (input.appendContent) {
		updatedContent = `${updatedContent.trimEnd()}\n\n${input.appendContent}`;
	}

	// Write back
	const newFileContent = matter.stringify(updatedContent, metadata);
	await writeFile(resolved.filepath, newFileContent, "utf-8");

	// Notify web server for real-time updates
	await notifyDocUpdate(resolved.filename);

	return successResponse({
		message: sectionUpdated
			? `Updated section "${sectionUpdated}" in ${resolved.filename}`
			: `Updated documentation: ${resolved.filename}`,
		doc: {
			path: resolved.filename.replace(/\.md$/, ""),
			title: metadata.title,
			description: metadata.description,
			tags: metadata.tags,
			updatedAt: metadata.updatedAt,
			...(sectionUpdated && { section: sectionUpdated }),
		},
	});
}

export async function handleSearchDocs(args: unknown) {
	const input = searchDocsSchema.parse(args);
	await ensureDocsDir();

	const mdFiles = await getAllMdFiles(DOCS_DIR);
	const query = input.query.toLowerCase();

	const results: Array<{
		path: string;
		title: string;
		description?: string;
		tags?: string[];
		matchContext?: string;
	}> = [];

	for (const file of mdFiles) {
		const fileContent = await readFile(join(DOCS_DIR, file), "utf-8");
		const { data, content } = matter(fileContent);
		const metadata = data as DocMetadata;

		// Filter by tag if specified
		if (input.tag && !metadata.tags?.includes(input.tag)) {
			continue;
		}

		// Search in title, description, tags, and content
		const titleMatch = metadata.title?.toLowerCase().includes(query);
		const descMatch = metadata.description?.toLowerCase().includes(query);
		const tagMatch = metadata.tags?.some((t) => t.toLowerCase().includes(query));
		const contentMatch = content.toLowerCase().includes(query);

		if (titleMatch || descMatch || tagMatch || contentMatch) {
			// Extract context around match in content
			let matchContext: string | undefined;
			if (contentMatch) {
				const contentLower = content.toLowerCase();
				const matchIndex = contentLower.indexOf(query);
				if (matchIndex !== -1) {
					const start = Math.max(0, matchIndex - 50);
					const end = Math.min(content.length, matchIndex + query.length + 50);
					matchContext = `...${content.slice(start, end).replace(/\n/g, " ")}...`;
				}
			}

			results.push({
				path: file.replace(/\.md$/, ""),
				title: metadata.title || file.replace(/\.md$/, ""),
				description: metadata.description,
				tags: metadata.tags,
				matchContext,
			});
		}
	}

	return successResponse({
		count: results.length,
		docs: results,
	});
}
