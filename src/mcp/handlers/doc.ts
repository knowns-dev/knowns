/**
 * Documentation management MCP handlers
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getIndexService } from "@search/index-service";
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
import { listAllDocs, resolveDoc, validateRefs } from "../../import";
import { errorResponse, successResponse } from "../utils";
import { getProjectRoot } from "./project";

// Get docs directory dynamically based on current project
function getDocsDir(): string {
	return join(getProjectRoot(), ".knowns", "docs");
}

/**
 * Normalize literal \n sequences to actual newlines.
 * Some MCP clients send escaped newlines as literal backslash-n.
 */
function normalizeNewlines(text: string | undefined): string | undefined {
	if (!text) return text;
	return text.replace(/\\n/g, "\n");
}

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
];

// Helper: Ensure docs directory exists
async function ensureDocsDir(): Promise<void> {
	if (!existsSync(getDocsDir())) {
		await mkdir(getDocsDir(), { recursive: true });
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
	let filepath = join(getDocsDir(), filename);

	if (existsSync(filepath)) {
		return { filepath, filename };
	}

	// Try converting title to filename (root level only)
	filename = `${titleToFilename(name)}.md`;
	filepath = join(getDocsDir(), filename);

	if (existsSync(filepath)) {
		return { filepath, filename };
	}

	// Try searching in all md files
	const allFiles = await getAllMdFiles(getDocsDir());
	const searchName = name.toLowerCase().replace(/\.md$/, "");

	const matchingFile = allFiles.find((file) => {
		const fileNameOnly = file.toLowerCase().replace(/\.md$/, "");
		const fileBaseName = file.split("/").pop()?.toLowerCase().replace(/\.md$/, "");
		return fileNameOnly === searchName || fileBaseName === searchName || file === name;
	});

	if (matchingFile) {
		return {
			filepath: join(getDocsDir(), matchingFile),
			filename: matchingFile,
		};
	}

	return null;
}

// Handlers
export async function handleListDocs(args: unknown) {
	const input = listDocsSchema.parse(args);
	await ensureDocsDir();

	const projectRoot = getProjectRoot();
	const allDocs = await listAllDocs(projectRoot);

	if (allDocs.length === 0) {
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
		source: string;
		sourceUrl?: string;
		isImported: boolean;
	}> = [];

	for (const doc of allDocs) {
		try {
			const fileContent = await readFile(doc.fullPath, "utf-8");
			const { data, content } = matter(fileContent);
			const metadata = data as DocMetadata;
			const stats = calculateDocStats(content);

			// Filter by tag if specified
			if (input.tag && !metadata.tags?.includes(input.tag)) {
				continue;
			}

			docs.push({
				path: doc.ref, // Use full ref path (includes import prefix if imported)
				title: metadata.title || doc.name,
				description: metadata.description,
				tags: metadata.tags,
				tokens: stats.estimatedTokens,
				updatedAt: metadata.updatedAt,
				source: doc.source,
				sourceUrl: doc.sourceUrl,
				isImported: doc.isImported,
			});
		} catch {
			// Skip files that can't be read
		}
	}

	return successResponse({
		count: docs.length,
		docs,
	});
}

export async function handleGetDoc(args: unknown) {
	const input = getDocSchema.parse(args);

	// Use import resolver to find both local and imported docs
	const projectRoot = getProjectRoot();
	const resolved = await resolveDoc(projectRoot, input.path);

	if (!resolved) {
		return errorResponse(`Documentation not found: ${input.path}`);
	}

	const fileContent = await readFile(resolved.path, "utf-8");
	const { data, content } = matter(fileContent);
	const metadata = data as DocMetadata;

	// Build doc path for response
	// If imported and input doesn't already have the import prefix, add it
	const inputPath = input.path.replace(/\.md$/, "");
	const docPath =
		resolved.isImported && !inputPath.startsWith(`${resolved.source}/`) ? `${resolved.source}/${inputPath}` : inputPath;

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
					path: docPath,
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
				path: docPath,
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
					path: docPath,
					title: metadata.title,
					toc: [],
					message: "No headings found in this document.",
				},
			});
		}

		return successResponse({
			doc: {
				path: docPath,
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
				path: docPath,
				title: metadata.title,
				section: input.section,
				content: sectionContent,
			},
		});
	}

	// Validate refs and collect broken ones
	const tasksDir = join(projectRoot, ".knowns", "tasks");
	const refs = await validateRefs(projectRoot, content, tasksDir);
	const brokenRefs = refs.filter((r) => !r.exists).map((r) => r.ref);

	// Default: return full document
	return successResponse({
		doc: {
			path: docPath,
			title: metadata.title,
			description: metadata.description,
			tags: metadata.tags,
			createdAt: metadata.createdAt,
			updatedAt: metadata.updatedAt,
			content: content.trim(),
			...(brokenRefs.length > 0 && { brokenRefs }),
		},
	});
}

export async function handleCreateDoc(args: unknown) {
	const input = createDocSchema.parse(args);
	await ensureDocsDir();

	const filename = `${titleToFilename(input.title)}.md`;

	// Handle folder path
	let targetDir = getDocsDir();
	let relativePath = filename;

	if (input.folder) {
		const folderPath = input.folder.replace(/^\/|\/$/g, "");
		targetDir = join(getDocsDir(), folderPath);
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

	const initialContent = normalizeNewlines(input.content) || "# Content\n\nWrite your documentation here.";
	const fileContent = matter.stringify(initialContent, metadata);

	await writeFile(filepath, fileContent, "utf-8");

	// Notify web server for real-time updates
	await notifyDocUpdate(relativePath);

	// Index doc for semantic search
	const docPath = relativePath.replace(/\.md$/, "");
	await getIndexService(getProjectRoot()).indexDoc(docPath, initialContent, {
		path: docPath,
		title: metadata.title,
		description: metadata.description,
		tags: metadata.tags,
	});

	return successResponse({
		message: `Created documentation: ${relativePath}`,
		doc: {
			path: docPath,
			title: metadata.title,
			description: metadata.description,
			tags: metadata.tags,
		},
	});
}

export async function handleUpdateDoc(args: unknown) {
	const input = updateDocSchema.parse(args);

	// Use import resolver to find both local and imported docs
	const projectRoot = getProjectRoot();
	const resolved = await resolveDoc(projectRoot, input.path);

	if (!resolved) {
		return errorResponse(`Documentation not found: ${input.path}`);
	}

	// Imported docs are read-only
	if (resolved.isImported) {
		return errorResponse(
			`Cannot update imported documentation: ${input.path}. Imported docs are read-only. To modify, copy to local docs first.`,
		);
	}

	const fileContent = await readFile(resolved.path, "utf-8");
	const { data, content } = matter(fileContent);
	const metadata = data as DocMetadata;

	// Update metadata
	if (input.title) metadata.title = input.title;
	if (input.description) metadata.description = input.description;
	if (input.tags) metadata.tags = input.tags;
	metadata.updatedAt = new Date().toISOString();

	// Update content (normalize literal \n to actual newlines)
	let updatedContent = content;
	let sectionUpdated: string | undefined;
	const normalizedContent = normalizeNewlines(input.content);
	const normalizedAppend = normalizeNewlines(input.appendContent);

	// Handle section replacement
	if (input.section && normalizedContent) {
		// Check if section is a pure number (index from TOC display)
		const sectionIndex = /^\d+$/.test(input.section) ? Number.parseInt(input.section, 10) : null;
		const result =
			sectionIndex !== null
				? replaceSectionByIndex(content, sectionIndex, normalizedContent)
				: replaceSection(content, input.section, normalizedContent);
		if (!result) {
			return errorResponse(
				`Section not found: ${input.section}. Use 'toc: true' with get_doc to see available sections.`,
			);
		}
		updatedContent = result;
		sectionUpdated = input.section;
	} else if (normalizedContent) {
		updatedContent = normalizedContent;
	}

	if (normalizedAppend) {
		updatedContent = `${updatedContent.trimEnd()}\n\n${normalizedAppend}`;
	}

	// Write back
	const newFileContent = matter.stringify(updatedContent, metadata);
	await writeFile(resolved.path, newFileContent, "utf-8");

	// Build doc path for response
	// If imported and input doesn't already have the import prefix, add it
	const inputPath = input.path.replace(/\.md$/, "");
	const docPath =
		resolved.isImported && !inputPath.startsWith(`${resolved.source}/`) ? `${resolved.source}/${inputPath}` : inputPath;

	// Notify web server for real-time updates
	await notifyDocUpdate(docPath);

	// Index doc for semantic search
	await getIndexService(projectRoot).indexDoc(docPath, updatedContent, {
		path: docPath,
		title: metadata.title,
		description: metadata.description,
		tags: metadata.tags,
	});

	return successResponse({
		message: sectionUpdated ? `Updated section "${sectionUpdated}" in ${docPath}` : `Updated documentation: ${docPath}`,
		doc: {
			path: docPath,
			title: metadata.title,
			description: metadata.description,
			tags: metadata.tags,
			updatedAt: metadata.updatedAt,
			...(sectionUpdated && { section: sectionUpdated }),
		},
	});
}
