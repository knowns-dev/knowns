/**
 * Documentation management MCP handlers
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
		description: "Get a documentation file by path (filename or folder/filename)",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Document path (e.g., 'readme', 'guides/setup', 'conventions/naming.md')",
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
		description: "Update an existing documentation file",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Document path (e.g., 'readme', 'guides/setup')",
				},
				title: { type: "string", description: "New title" },
				description: { type: "string", description: "New description" },
				content: { type: "string", description: "Replace content" },
				tags: {
					type: "array",
					items: { type: "string" },
					description: "New tags",
				},
				appendContent: {
					type: "string",
					description: "Append to existing content",
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
		const relativePath = basePath ? join(basePath, entry.name) : entry.name;

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
		updatedAt: string;
	}> = [];

	for (const file of mdFiles) {
		const content = await readFile(join(DOCS_DIR, file), "utf-8");
		const { data } = matter(content);
		const metadata = data as DocMetadata;

		// Filter by tag if specified
		if (input.tag && !metadata.tags?.includes(input.tag)) {
			continue;
		}

		docs.push({
			path: file.replace(/\.md$/, ""),
			title: metadata.title || file.replace(/\.md$/, ""),
			description: metadata.description,
			tags: metadata.tags,
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
	if (input.content) {
		updatedContent = input.content;
	}
	if (input.appendContent) {
		updatedContent = `${content.trimEnd()}\n\n${input.appendContent}`;
	}

	// Write back
	const newFileContent = matter.stringify(updatedContent, metadata);
	await writeFile(resolved.filepath, newFileContent, "utf-8");

	// Notify web server for real-time updates
	await notifyDocUpdate(resolved.filename);

	return successResponse({
		message: `Updated documentation: ${resolved.filename}`,
		doc: {
			path: resolved.filename.replace(/\.md$/, ""),
			title: metadata.title,
			description: metadata.description,
			tags: metadata.tags,
			updatedAt: metadata.updatedAt,
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
