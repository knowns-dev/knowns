/**
 * Documentation management commands
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { FileStore } from "@storage/file-store";
import { findProjectRoot } from "@utils/find-project-root";
import { normalizePath } from "@utils/index";
import {
	calculateDocStats,
	extractSection,
	extractSectionByIndex,
	extractToc,
	formatDocStats,
	formatToc,
	replaceSection,
	replaceSectionByIndex,
} from "@utils/markdown-toc";
import { normalizeRefs } from "@utils/mention-refs";
import { notifyDocUpdate } from "@utils/notify-server";
import { repairDoc, validateDoc } from "@utils/validate";
import chalk from "chalk";
import { Command } from "commander";
import matter from "gray-matter";

const DOCS_DIR = join(process.cwd(), ".knowns", "docs");

// Recursively read all .md files in a directory
async function getAllMdFiles(dir: string, basePath = ""): Promise<string[]> {
	const files: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		// Use forward slashes for cross-platform consistency (Windows uses backslash)
		const relativePath = normalizePath(basePath ? join(basePath, entry.name) : entry.name);

		if (entry.isDirectory()) {
			// Recursively read subdirectories
			const subFiles = await getAllMdFiles(fullPath, relativePath);
			files.push(...subFiles);
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			files.push(relativePath);
		}
	}

	return files;
}

interface DocMetadata {
	title: string;
	description?: string;
	createdAt: string;
	updatedAt: string;
	tags?: string[];
}

// Ensure docs directory exists
async function ensureDocsDir(): Promise<void> {
	if (!existsSync(DOCS_DIR)) {
		await mkdir(DOCS_DIR, { recursive: true });
	}
}

// Convert title to filename
function titleToFilename(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

// Format doc filename to display name
function filenameToTitle(filename: string): string {
	return filename
		.replace(/\.md$/, "")
		.split("-")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

// Resolve doc name to filepath and filename
async function resolveDocPath(name: string): Promise<{ filepath: string; filename: string } | null> {
	await ensureDocsDir();

	// Try multiple approaches to find the file
	let filename = name.endsWith(".md") ? name : `${name}.md`;
	let filepath = join(DOCS_DIR, filename);

	if (!existsSync(filepath)) {
		// Try converting title to filename (root level only)
		filename = `${titleToFilename(name)}.md`;
		filepath = join(DOCS_DIR, filename);
	}

	if (!existsSync(filepath)) {
		// Try searching in all md files
		const allFiles = await getAllMdFiles(DOCS_DIR);
		const searchName = name.toLowerCase().replace(/\.md$/, "");

		const matchingFile = allFiles.find((file) => {
			const fileNameOnly = file.toLowerCase().replace(/\.md$/, "");
			const fileBaseName = file.split("/").pop()?.toLowerCase().replace(/\.md$/, "");
			return fileNameOnly === searchName || fileBaseName === searchName || file === name;
		});

		if (matchingFile) {
			filename = matchingFile;
			filepath = join(DOCS_DIR, matchingFile);
		}
	}

	if (!existsSync(filepath)) {
		return null;
	}

	return { filepath, filename };
}

// Create command
const createCommand = new Command("create")
	.description("Create a new documentation file")
	.argument("<title>", "Document title")
	.option("-d, --description <text>", "Document description")
	.option("-t, --tags <tags>", "Comma-separated tags")
	.option("-f, --folder <path>", "Folder path (e.g., guides, patterns/auth)")
	.option("--plain", "Plain text output for AI")
	.action(
		async (
			title: string,
			options: {
				description?: string;
				tags?: string;
				folder?: string;
				plain?: boolean;
			},
		) => {
			try {
				await ensureDocsDir();

				const filename = `${titleToFilename(title)}.md`;

				// Handle folder path
				let targetDir = DOCS_DIR;
				let relativePath = filename;
				if (options.folder) {
					const folderPath = options.folder.replace(/^\/|\/$/g, ""); // Remove leading/trailing slashes
					targetDir = join(DOCS_DIR, folderPath);
					relativePath = join(folderPath, filename);
					// Ensure folder exists
					if (!existsSync(targetDir)) {
						await mkdir(targetDir, { recursive: true });
					}
				}

				const filepath = join(targetDir, filename);

				if (existsSync(filepath)) {
					console.error(chalk.red(`✗ Document already exists: ${relativePath}`));
					process.exit(1);
				}

				const now = new Date().toISOString();
				const metadata: DocMetadata = {
					title,
					createdAt: now,
					updatedAt: now,
				};

				// Normalize refs in description to ensure consistent storage
				if (options.description) {
					metadata.description = normalizeRefs(options.description);
				}

				if (options.tags) {
					metadata.tags = options.tags.split(",").map((t) => t.trim());
				}

				const content = matter.stringify("# Content\n\nWrite your documentation here.\n", metadata);

				await writeFile(filepath, content, "utf-8");

				// Notify web server for real-time updates
				await notifyDocUpdate(relativePath);

				if (options.plain) {
					console.log(`Created: ${relativePath}`);
				} else {
					console.log(chalk.green(`✓ Created documentation: ${chalk.bold(relativePath)}`));
					console.log(chalk.gray(`  Location: ${filepath}`));
				}
			} catch (error) {
				console.error(
					chalk.red("Error creating documentation:"),
					error instanceof Error ? error.message : String(error),
				);
				process.exit(1);
			}
		},
	);

// List command
const listCommand = new Command("list")
	.description("List all documentation files")
	.argument("[path]", "Filter by path (e.g., 'guides/' or 'patterns/')")
	.option("--plain", "Plain text output for AI")
	.option("-t, --tag <tag>", "Filter by tag")
	.action(async (path: string | undefined, options: { plain?: boolean; tag?: string }) => {
		try {
			await ensureDocsDir();

			const mdFiles = await getAllMdFiles(DOCS_DIR);

			if (mdFiles.length === 0) {
				if (options.plain) {
					console.log("No documentation found");
				} else {
					console.log(chalk.yellow("No documentation files found."));
					console.log(chalk.gray(`Create one with: knowns doc create "Title"`));
				}
				return;
			}

			const docs: Array<{
				filename: string;
				metadata: DocMetadata;
				tokens: number;
			}> = [];

			for (const file of mdFiles) {
				const fileContent = await readFile(join(DOCS_DIR, file), "utf-8");
				const { data, content } = matter(fileContent);
				const stats = calculateDocStats(content);
				docs.push({
					filename: file,
					metadata: data as DocMetadata,
					tokens: stats.estimatedTokens,
				});
			}

			// Filter by path if specified
			let filteredDocs = docs;
			if (path) {
				const normalizedPath = path.endsWith("/") ? path : `${path}/`;
				filteredDocs = docs.filter((doc) => doc.filename.startsWith(normalizedPath));
			}

			// Filter by tag if specified
			if (options.tag) {
				filteredDocs = filteredDocs.filter((doc) => doc.metadata.tags?.includes(options.tag));
			}

			if (filteredDocs.length === 0) {
				const filterMsg = path ? `path: ${path}` : options.tag ? `tag: ${options.tag}` : "";
				console.log(
					options.plain
						? "No documentation found"
						: chalk.yellow(`No documentation found${filterMsg ? ` with ${filterMsg}` : ""}`),
				);
				return;
			}

			if (options.plain) {
				// Tree format for token efficiency (folder name once, files indented)
				const folders = new Map<string, Array<{ name: string; title: string; tokens: number }>>();
				const rootDocs: Array<{
					name: string;
					title: string;
					tokens: number;
				}> = [];

				for (const doc of filteredDocs) {
					const parts = doc.filename.split("/");
					if (parts.length === 1) {
						rootDocs.push({
							name: parts[0].replace(/\.md$/, ""),
							title: doc.metadata.title,
							tokens: doc.tokens,
						});
					} else {
						const folder = parts.slice(0, -1).join("/");
						const name = parts[parts.length - 1].replace(/\.md$/, "");
						if (!folders.has(folder)) {
							folders.set(folder, []);
						}
						folders.get(folder)?.push({ name, title: doc.metadata.title, tokens: doc.tokens });
					}
				}

				const sortedFolders = Array.from(folders.keys()).sort();
				for (const folder of sortedFolders) {
					console.log(`${folder}/`);
					const docs = folders.get(folder)?.sort((a, b) => a.name.localeCompare(b.name));
					for (const doc of docs) {
						console.log(`  ${doc.name} - ${doc.title} (~${doc.tokens} tokens)`);
					}
				}
				if (rootDocs.length > 0) {
					rootDocs.sort((a, b) => a.name.localeCompare(b.name));
					for (const doc of rootDocs) {
						console.log(`${doc.name} - ${doc.title} (~${doc.tokens} tokens)`);
					}
				}
			} else {
				// List format for humans - grouped by folder
				const folders = new Map<string, typeof filteredDocs>();
				const rootDocs: typeof filteredDocs = [];

				for (const doc of filteredDocs) {
					const parts = doc.filename.split("/");
					if (parts.length === 1) {
						rootDocs.push(doc);
					} else {
						const folder = parts.slice(0, -1).join("/");
						if (!folders.has(folder)) {
							folders.set(folder, []);
						}
						folders.get(folder)?.push(doc);
					}
				}

				console.log(chalk.bold(`\nDocumentation (${filteredDocs.length})\n`));

				const sortedFolders = Array.from(folders.keys()).sort();
				for (const folder of sortedFolders) {
					console.log(chalk.cyan.bold(`${folder}/`));
					const docs = folders.get(folder)?.sort((a, b) => a.metadata.title.localeCompare(b.metadata.title));
					for (const doc of docs) {
						console.log(chalk.white(`  ${doc.metadata.title}`));
						if (doc.metadata.description) {
							console.log(chalk.gray(`    ${doc.metadata.description}`));
						}
						if (doc.metadata.tags && doc.metadata.tags.length > 0) {
							console.log(chalk.gray(`    Tags: ${doc.metadata.tags.join(", ")}`));
						}
					}
					console.log();
				}

				// Root docs
				if (rootDocs.length > 0) {
					rootDocs.sort((a, b) => a.metadata.title.localeCompare(b.metadata.title));
					for (const doc of rootDocs) {
						console.log(chalk.white(`${doc.metadata.title}`));
						if (doc.metadata.description) {
							console.log(chalk.gray(`  ${doc.metadata.description}`));
						}
						if (doc.metadata.tags && doc.metadata.tags.length > 0) {
							console.log(chalk.gray(`  Tags: ${doc.metadata.tags.join(", ")}`));
						}
						console.log();
					}
				}
			}
		} catch (error) {
			console.error(chalk.red("Error listing documentation:"), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

// View command
const viewCommand = new Command("view")
	.description("View a documentation file")
	.argument("<name>", "Document name (filename or title or path)")
	.option("--plain", "Plain text output for AI")
	.option("--info", "Show document stats (size, tokens, headings) without content")
	.option("--toc", "Show table of contents only")
	.option("--section <title>", "Show specific section by heading title or number (e.g., '2. Overview' or '2')")
	.option("--smart", "Smart mode: auto-return full content if small, or stats+TOC if large (>2000 tokens)")
	.action(
		async (
			name: string,
			options: {
				plain?: boolean;
				info?: boolean;
				toc?: boolean;
				section?: string;
				smart?: boolean;
			},
		) => {
			try {
				await ensureDocsDir();

				// Try multiple approaches to find the file
				let filename = name.endsWith(".md") ? name : `${name}.md`;
				let filepath = join(DOCS_DIR, filename);

				if (!existsSync(filepath)) {
					// Try converting title to filename (root level only)
					filename = `${titleToFilename(name)}.md`;
					filepath = join(DOCS_DIR, filename);
				}

				if (!existsSync(filepath)) {
					// Try searching in all md files
					const allFiles = await getAllMdFiles(DOCS_DIR);
					const searchName = name.toLowerCase().replace(/\.md$/, "");

					const matchingFile = allFiles.find((file) => {
						const fileNameOnly = file.toLowerCase().replace(/\.md$/, "");
						const fileBaseName = file.split("/").pop()?.toLowerCase().replace(/\.md$/, "");
						return fileNameOnly === searchName || fileBaseName === searchName || file === name;
					});

					if (matchingFile) {
						filename = matchingFile;
						filepath = join(DOCS_DIR, matchingFile);
					}
				}

				if (!existsSync(filepath)) {
					console.error(chalk.red(`✗ Documentation not found: ${name}`));
					process.exit(1);
				}

				const fileContent = await readFile(filepath, "utf-8");
				const { data, content } = matter(fileContent);
				const metadata = data as DocMetadata;

				// Handle --smart option: auto-decide based on document size
				if (options.smart) {
					const stats = calculateDocStats(content);
					const SMART_THRESHOLD = 2000; // tokens

					if (stats.estimatedTokens <= SMART_THRESHOLD) {
						// Small doc: return full content (fall through to default behavior)
						// Don't return here, let it continue to the default content output
					} else {
						// Large doc: return stats + TOC
						const toc = extractToc(content);

						if (options.plain) {
							console.log(`Document: ${metadata.title}`);
							console.log("=".repeat(50));
							console.log();
							console.log(
								`Size: ${stats.chars.toLocaleString()} chars (~${stats.estimatedTokens.toLocaleString()} tokens)`,
							);
							console.log(`Headings: ${stats.headingCount}`);
							console.log();
							console.log("Table of Contents:");
							console.log("-".repeat(50));
							toc.forEach((entry, index) => {
								const indent = "  ".repeat(entry.level - 1);
								console.log(`${indent}${index + 1}. ${entry.title}`);
							});
							console.log();
							console.log("Document is large. Use --section <number> to read a specific section.");
						} else {
							console.log(chalk.bold(`\n📄 ${metadata.title} (Smart Mode)\n`));
							console.log(
								`Size: ${chalk.cyan(stats.chars.toLocaleString())} chars (~${chalk.yellow(stats.estimatedTokens.toLocaleString())} tokens)`,
							);
							console.log();
							console.log(chalk.bold("Table of Contents:"));
							console.log(formatToc(toc));
							console.log();
							console.log(chalk.yellow("⚠ Document is large. Use --section <number> to read a specific section."));
						}
						return;
					}
				}

				// Handle --info option
				if (options.info) {
					const stats = calculateDocStats(content);
					if (options.plain) {
						console.log(formatDocStats(stats, metadata.title));
					} else {
						console.log(chalk.bold(`\n📊 ${metadata.title} - Document Info\n`));
						console.log(
							`Size: ${chalk.cyan(stats.chars.toLocaleString())} chars (~${chalk.yellow(stats.estimatedTokens.toLocaleString())} tokens)`,
						);
						console.log(`Words: ${stats.words.toLocaleString()}`);
						console.log(`Lines: ${stats.lines.toLocaleString()}`);
						console.log(`Headings: ${stats.headingCount}`);
						console.log();
						if (stats.estimatedTokens > 4000) {
							console.log(chalk.yellow("⚠ Document is large. Use --toc first, then --section."));
						} else if (stats.estimatedTokens > 2000) {
							console.log(chalk.gray("Consider using --toc and --section for specific info."));
						} else {
							console.log(chalk.green("✓ Document is small enough to read directly."));
						}
						console.log();
					}
					return;
				}

				// Handle --toc option
				if (options.toc) {
					const toc = extractToc(content);
					if (toc.length === 0) {
						console.log(options.plain ? "No headings found." : chalk.yellow("No headings found in this document."));
						return;
					}

					if (options.plain) {
						console.log(`Table of Contents: ${metadata.title}`);
						console.log("=".repeat(50));
						console.log();
						toc.forEach((entry, index) => {
							const indent = "  ".repeat(entry.level - 1);
							console.log(`${indent}${index + 1}. ${entry.title}`);
						});
						console.log();
						console.log("Use --section <number or title> to view a specific section.");
					} else {
						console.log(chalk.bold(`\n📄 ${metadata.title} - Table of Contents\n`));
						console.log(formatToc(toc));
						console.log(chalk.gray("\nUse --section <number or title> to view a specific section."));
					}
					return;
				}

				// Handle --section option
				if (options.section) {
					// Check if section is a pure number (index from TOC display)
					const sectionIndex = /^\d+$/.test(options.section) ? Number.parseInt(options.section, 10) : null;
					const sectionContent =
						sectionIndex !== null
							? extractSectionByIndex(content, sectionIndex)
							: extractSection(content, options.section);
					if (!sectionContent) {
						console.error(
							options.plain
								? `Section not found: ${options.section}`
								: chalk.red(`✗ Section not found: ${options.section}`),
						);
						console.log(
							options.plain
								? "Use --toc to see available sections."
								: chalk.gray("Use --toc to see available sections."),
						);
						process.exit(1);
					}

					if (options.plain) {
						console.log(`File: ${process.cwd()}/.knowns/docs/${filename}`);
						console.log(`Section: ${options.section}`);
						console.log("=".repeat(50));
						console.log();
						console.log(sectionContent);
					} else {
						console.log(chalk.bold(`\n📄 ${metadata.title} - Section\n`));
						console.log(sectionContent);
						console.log();
					}
					return;
				}

				if (options.plain) {
					const border = "-".repeat(50);
					const titleBorder = "=".repeat(50);

					// File path
					const projectRoot = process.cwd();
					console.log(`File: ${projectRoot}/.knowns/docs/${filename}`);
					console.log();

					// Title
					console.log(metadata.title);
					console.log(titleBorder);
					console.log();

					// Metadata
					console.log(`Created: ${metadata.createdAt}`);
					console.log(`Updated: ${metadata.updatedAt}`);
					if (metadata.tags && metadata.tags.length > 0) {
						console.log(`Tags: ${metadata.tags.join(", ")}`);
					}

					// Description
					if (metadata.description) {
						console.log();
						console.log("Description:");
						console.log(border);
						console.log(metadata.description);
					}

					// Content with resolved links
					console.log();
					console.log("Content:");
					console.log(border);

					// Parse and enhance markdown links
					const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
					let enhancedContent = content.trimEnd();
					const linksToAdd: Array<{ original: string; resolved: string }> = [];

					let match: RegExpExecArray | null;
					// biome-ignore lint/suspicious/noAssignInExpressions: Standard regex iteration pattern
					while ((match = linkPattern.exec(content)) !== null) {
						const _linkText = match[1];
						const linkTarget = match[2];
						const fullMatch = match[0];

						// Skip external URLs
						if (linkTarget.startsWith("http://") || linkTarget.startsWith("https://")) {
							continue;
						}

						// Skip relative paths that go outside docs
						if (linkTarget.startsWith("../")) {
							continue;
						}

						// Normalize filename
						let resolvedFilename = linkTarget.replace(/^\.\//, "");
						if (!resolvedFilename.endsWith(".md")) {
							resolvedFilename = `${resolvedFilename}.md`;
						}

						const resolvedPath = `@.knowns/docs/${resolvedFilename}`;
						linksToAdd.push({
							original: fullMatch,
							resolved: resolvedPath,
						});
					}

					// Replace each link with resolved path only
					for (const { original, resolved } of linksToAdd) {
						enhancedContent = enhancedContent.replace(original, resolved);
					}

					console.log(enhancedContent);
				} else {
					console.log(chalk.bold(`\n📄 ${metadata.title}\n`));
					if (metadata.description) {
						console.log(chalk.gray(metadata.description));
						console.log();
					}
					if (metadata.tags && metadata.tags.length > 0) {
						console.log(chalk.gray(`Tags: ${metadata.tags.join(", ")}`));
					}
					console.log(chalk.gray(`Updated: ${new Date(metadata.updatedAt).toLocaleString()}`));
					console.log(chalk.gray("-".repeat(60)));
					console.log(content);
					console.log();
				}
			} catch (error) {
				console.error(
					chalk.red("Error viewing documentation:"),
					error instanceof Error ? error.message : String(error),
				);
				process.exit(1);
			}
		},
	);

// Edit command
const editCommand = new Command("edit")
	.description("Edit a documentation file (metadata and content)")
	.argument("<name>", "Document name or path (e.g., guides/my-doc)")
	.option("-t, --title <text>", "New title")
	.option("-d, --description <text>", "New description")
	.option("--tags <tags>", "Comma-separated tags")
	.option("-c, --content <text>", "Replace content (or section content if --section used)")
	.option("-a, --append <text>", "Append to content")
	.option("--section <title>", "Target section to replace (use with -c)")
	.option("--content-file <path>", "Replace content with file contents")
	.option("--append-file <path>", "Append file contents to document")
	.option("--plain", "Plain text output for AI")
	.action(
		async (
			name: string,
			options: {
				title?: string;
				description?: string;
				tags?: string;
				content?: string;
				append?: string;
				section?: string;
				contentFile?: string;
				appendFile?: string;
				plain?: boolean;
			},
		) => {
			try {
				await ensureDocsDir();

				// Find the file - support nested paths
				let filename = name.endsWith(".md") ? name : `${name}.md`;
				let filepath = join(DOCS_DIR, filename);

				if (!existsSync(filepath)) {
					// Try converting title to filename
					const baseName = name.includes("/") ? name : titleToFilename(name);
					filename = baseName.endsWith(".md") ? baseName : `${baseName}.md`;
					filepath = join(DOCS_DIR, filename);
				}

				if (!existsSync(filepath)) {
					// Try searching in all md files
					const allFiles = await getAllMdFiles(DOCS_DIR);
					const searchName = name.toLowerCase().replace(/\.md$/, "");

					const matchingFile = allFiles.find((file) => {
						const fileNameOnly = file.toLowerCase().replace(/\.md$/, "");
						const fileBaseName = file.split("/").pop()?.toLowerCase().replace(/\.md$/, "");
						return fileNameOnly === searchName || fileBaseName === searchName || file === name;
					});

					if (matchingFile) {
						filename = matchingFile;
						filepath = join(DOCS_DIR, matchingFile);
					}
				}

				if (!existsSync(filepath)) {
					console.error(chalk.red(`✗ Documentation not found: ${name}`));
					process.exit(1);
				}

				const fileContent = await readFile(filepath, "utf-8");
				const { data, content } = matter(fileContent);
				const metadata = data as DocMetadata;

				// Update metadata (normalize refs to ensure consistent storage)
				if (options.title) metadata.title = options.title;
				if (options.description) metadata.description = normalizeRefs(options.description);
				if (options.tags) metadata.tags = options.tags.split(",").map((t) => t.trim());
				metadata.updatedAt = new Date().toISOString();

				// Update content (normalize refs to ensure consistent storage)
				let updatedContent = content;
				let sourceFile: string | undefined;

				// Handle --content-file (replace content with file contents)
				if (options.contentFile) {
					if (!existsSync(options.contentFile)) {
						console.error(chalk.red(`✗ File not found: ${options.contentFile}`));
						process.exit(1);
					}
					const fileData = await readFile(options.contentFile, "utf-8");
					updatedContent = normalizeRefs(fileData);
					sourceFile = options.contentFile;
				}
				// Handle --append-file (append file contents)
				else if (options.appendFile) {
					if (!existsSync(options.appendFile)) {
						console.error(chalk.red(`✗ File not found: ${options.appendFile}`));
						process.exit(1);
					}
					const fileData = await readFile(options.appendFile, "utf-8");
					updatedContent = `${content.trimEnd()}\n\n${normalizeRefs(fileData)}`;
					sourceFile = options.appendFile;
				}
				// Handle --section with -c (replace specific section)
				else if (options.section && options.content) {
					// Check if section is a pure number (index from TOC display)
					const sectionIndex = /^\d+$/.test(options.section) ? Number.parseInt(options.section, 10) : null;
					const result =
						sectionIndex !== null
							? replaceSectionByIndex(content, sectionIndex, normalizeRefs(options.content))
							: replaceSection(content, options.section, normalizeRefs(options.content));
					if (!result) {
						console.error(
							options.plain
								? `Section not found: ${options.section}`
								: chalk.red(`✗ Section not found: ${options.section}`),
						);
						console.log(
							options.plain
								? "Use 'knowns doc <path> --toc --plain' to see available sections."
								: chalk.gray("Use 'knowns doc <path> --toc --plain' to see available sections."),
						);
						process.exit(1);
					}
					updatedContent = result;
				}
				// Original behavior with inline content
				else if (options.content) {
					updatedContent = normalizeRefs(options.content);
				} else if (options.append) {
					updatedContent = `${content.trimEnd()}\n\n${normalizeRefs(options.append)}`;
				}

				// Write back
				const newFileContent = matter.stringify(updatedContent, metadata);
				await writeFile(filepath, newFileContent, "utf-8");

				// Notify web server for real-time updates
				await notifyDocUpdate(filename);

				if (options.plain) {
					console.log(`Updated: ${filename}`);
					if (options.section) {
						console.log(`Section: ${options.section}`);
					}
					if (sourceFile) {
						console.log(`Content from: ${sourceFile}`);
					}
				} else {
					console.log(chalk.green(`✓ Updated documentation: ${chalk.bold(filename)}`));
					if (options.section) {
						console.log(chalk.gray(`  Section: ${options.section}`));
					}
					if (sourceFile) {
						console.log(chalk.gray(`  Content from: ${sourceFile}`));
					}
				}
			} catch (error) {
				console.error(
					chalk.red("Error editing documentation:"),
					error instanceof Error ? error.message : String(error),
				);
				process.exit(1);
			}
		},
	);

// Validate command
const validateCommand = new Command("validate")
	.description("Validate a documentation file format")
	.argument("<name>", "Document name or path")
	.option("--plain", "Plain text output for AI")
	.action(async (name: string, options: { plain?: boolean }) => {
		try {
			const resolved = await resolveDocPath(name);
			if (!resolved) {
				console.error(chalk.red(`✗ Documentation not found: ${name}`));
				process.exit(1);
			}

			const content = await readFile(resolved.filepath, "utf-8");
			const result = validateDoc(content);

			if (options.plain) {
				console.log(`Validating: ${resolved.filename}`);
				console.log(`Valid: ${result.valid}`);
				if (result.errors.length > 0) {
					console.log("\nErrors:");
					for (const error of result.errors) {
						console.log(`  ✗ ${error.field}: ${error.message}${error.fixable ? " (fixable)" : ""}`);
					}
				}
				if (result.warnings.length > 0) {
					console.log("\nWarnings:");
					for (const warning of result.warnings) {
						console.log(`  ⚠ ${warning.field}: ${warning.message}`);
					}
				}
				if (result.valid && result.warnings.length === 0) {
					console.log("No issues found.");
				}
			} else {
				console.log(chalk.bold(`\n📋 Validation: ${resolved.filename}\n`));
				if (result.valid) {
					console.log(chalk.green("✓ Document is valid"));
				} else {
					console.log(chalk.red("✗ Document has errors"));
				}

				if (result.errors.length > 0) {
					console.log(chalk.red("\nErrors:"));
					for (const error of result.errors) {
						const fixable = error.fixable ? chalk.gray(" (fixable)") : "";
						console.log(chalk.red(`  ✗ ${error.field}: ${error.message}${fixable}`));
					}
				}

				if (result.warnings.length > 0) {
					console.log(chalk.yellow("\nWarnings:"));
					for (const warning of result.warnings) {
						console.log(chalk.yellow(`  ⚠ ${warning.field}: ${warning.message}`));
					}
				}

				if (result.valid && result.warnings.length === 0) {
					console.log(chalk.gray("\nNo issues found."));
				}
				console.log();
			}

			process.exit(result.valid ? 0 : 1);
		} catch (error) {
			console.error(
				chalk.red("Error validating documentation:"),
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	});

// Repair command
const repairCommand = new Command("repair")
	.description("Repair a corrupted documentation file")
	.argument("<name>", "Document name or path")
	.option("--plain", "Plain text output for AI")
	.action(async (name: string, options: { plain?: boolean }) => {
		try {
			const resolved = await resolveDocPath(name);
			if (!resolved) {
				console.error(chalk.red(`✗ Documentation not found: ${name}`));
				process.exit(1);
			}

			const result = await repairDoc(resolved.filepath);

			if (options.plain) {
				console.log(`Repairing: ${resolved.filename}`);
				console.log(`Success: ${result.success}`);
				if (result.backupPath) {
					console.log(`Backup: ${result.backupPath}`);
				}
				if (result.fixes.length > 0) {
					console.log("\nFixes applied:");
					for (const fix of result.fixes) {
						console.log(`  ✓ ${fix}`);
					}
				}
				if (result.errors.length > 0) {
					console.log("\nErrors:");
					for (const error of result.errors) {
						console.log(`  ✗ ${error}`);
					}
				}
			} else {
				console.log(chalk.bold(`\n🔧 Repair: ${resolved.filename}\n`));

				if (result.success) {
					console.log(chalk.green("✓ Document repaired successfully"));
				} else {
					console.log(chalk.red("✗ Repair failed"));
				}

				if (result.backupPath) {
					console.log(chalk.gray(`  Backup created: ${result.backupPath}`));
				}

				if (result.fixes.length > 0) {
					console.log(chalk.green("\nFixes applied:"));
					for (const fix of result.fixes) {
						console.log(chalk.green(`  ✓ ${fix}`));
					}
				}

				if (result.errors.length > 0) {
					console.log(chalk.red("\nErrors:"));
					for (const error of result.errors) {
						console.log(chalk.red(`  ✗ ${error}`));
					}
				}
				console.log();
			}

			// Notify server of update
			if (result.success) {
				await notifyDocUpdate(resolved.filename);
			}

			process.exit(result.success ? 0 : 1);
		} catch (error) {
			console.error(
				chalk.red("Error repairing documentation:"),
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	});

// Search-in command - search text within a document
const searchInCommand = new Command("search-in")
	.description("Search text within a specific document")
	.argument("<name>", "Document name or path")
	.argument("<query>", "Text to search for")
	.option("--plain", "Plain text output for AI")
	.option("-i, --ignore-case", "Case insensitive search")
	.action(async (name: string, query: string, options: { plain?: boolean; ignoreCase?: boolean }) => {
		try {
			const resolved = await resolveDocPath(name);
			if (!resolved) {
				console.error(chalk.red(`✗ Documentation not found: ${name}`));
				process.exit(1);
			}

			const fileContent = await readFile(resolved.filepath, "utf-8");
			const { content } = matter(fileContent);
			const lines = content.split("\n");

			const matches: Array<{
				lineNum: number;
				line: string;
				context: string;
			}> = [];
			const searchQuery = options.ignoreCase ? query.toLowerCase() : query;

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				const searchLine = options.ignoreCase ? line.toLowerCase() : line;

				if (searchLine.includes(searchQuery)) {
					// Get context (1 line before and after)
					const contextStart = Math.max(0, i - 1);
					const contextEnd = Math.min(lines.length - 1, i + 1);
					const context = lines.slice(contextStart, contextEnd + 1).join("\n");

					matches.push({
						lineNum: i + 1, // 1-indexed
						line: line,
						context: context,
					});
				}
			}

			if (options.plain) {
				console.log(`Searching in: ${resolved.filename}`);
				console.log(`Query: "${query}"`);
				console.log(`Found: ${matches.length} match(es)`);
				console.log();
				for (const match of matches) {
					console.log(`Line ${match.lineNum}: ${match.line.trim()}`);
				}
			} else {
				console.log(chalk.bold(`\n🔍 Search in: ${resolved.filename}\n`));
				console.log(chalk.gray(`Query: "${query}"`));
				console.log(chalk.gray(`Found: ${matches.length} match(es)\n`));

				for (const match of matches) {
					console.log(chalk.cyan(`Line ${match.lineNum}:`));
					console.log(chalk.white(`  ${match.line.trim()}`));
					console.log();
				}
			}
		} catch (error) {
			console.error(chalk.red("Error searching document:"), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

// Replace command - replace text in a document
const replaceCommand = new Command("replace")
	.description("Replace text in a document")
	.argument("<name>", "Document name or path")
	.argument("<old-text>", "Text to find")
	.argument("<new-text>", "Text to replace with")
	.option("--plain", "Plain text output for AI")
	.option("-a, --all", "Replace all occurrences (default: first only)")
	.action(async (name: string, oldText: string, newText: string, options: { plain?: boolean; all?: boolean }) => {
		try {
			const resolved = await resolveDocPath(name);
			if (!resolved) {
				console.error(chalk.red(`✗ Documentation not found: ${name}`));
				process.exit(1);
			}

			const fileContent = await readFile(resolved.filepath, "utf-8");
			const { data, content } = matter(fileContent);

			// Check if old text exists
			if (!content.includes(oldText)) {
				if (options.plain) {
					console.log(`Text not found: "${oldText}"`);
				} else {
					console.log(chalk.yellow(`⚠ Text not found: "${oldText}"`));
				}
				process.exit(1);
			}

			// Replace text
			let newContent: string;
			let count = 0;

			if (options.all) {
				// Replace all occurrences
				const parts = content.split(oldText);
				count = parts.length - 1;
				newContent = parts.join(newText);
			} else {
				// Replace first occurrence only
				newContent = content.replace(oldText, newText);
				count = 1;
			}

			// Update metadata
			const metadata = data as { updatedAt?: string };
			metadata.updatedAt = new Date().toISOString();

			// Write back
			const updatedFileContent = matter.stringify(newContent, data);
			await writeFile(resolved.filepath, updatedFileContent, "utf-8");

			// Notify server
			await notifyDocUpdate(resolved.filename);

			if (options.plain) {
				console.log(`Updated: ${resolved.filename}`);
				console.log(`Replaced: ${count} occurrence(s)`);
			} else {
				console.log(chalk.green(`✓ Updated: ${resolved.filename}`));
				console.log(chalk.gray(`  Replaced ${count} occurrence(s)`));
			}
		} catch (error) {
			console.error(chalk.red("Error replacing text:"), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

// Replace-section command - replace entire section by header
const replaceSectionCommand = new Command("replace-section")
	.description("Replace an entire section by its header")
	.argument("<name>", "Document name or path")
	.argument("<header>", "Section header (e.g., '## Section Name')")
	.argument("<content>", "New section content (without header)")
	.option("--plain", "Plain text output for AI")
	.action(async (name: string, header: string, newSectionContent: string, options: { plain?: boolean }) => {
		try {
			const resolved = await resolveDocPath(name);
			if (!resolved) {
				console.error(chalk.red(`✗ Documentation not found: ${name}`));
				process.exit(1);
			}

			const fileContent = await readFile(resolved.filepath, "utf-8");
			const { data, content } = matter(fileContent);

			// Find the section
			const headerLevel = (header.match(/^#+/) || ["##"])[0];
			const headerPattern = new RegExp(`^${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");

			const headerMatch = content.match(headerPattern);
			if (!headerMatch) {
				if (options.plain) {
					console.log(`Section not found: "${header}"`);
				} else {
					console.log(chalk.yellow(`⚠ Section not found: "${header}"`));
				}
				process.exit(1);
			}

			const headerIndex = content.indexOf(headerMatch[0]);

			// Find the end of the section (next header of same or higher level, or end of content)
			const afterHeader = content.substring(headerIndex + headerMatch[0].length);
			const nextHeaderPattern = new RegExp(`^#{1,${headerLevel.length}}\\s+`, "m");
			const nextHeaderMatch = afterHeader.match(nextHeaderPattern);

			let sectionEnd: number;
			if (nextHeaderMatch) {
				sectionEnd = headerIndex + headerMatch[0].length + afterHeader.indexOf(nextHeaderMatch[0]);
			} else {
				sectionEnd = content.length;
			}

			// Build new content
			const beforeSection = content.substring(0, headerIndex);
			const afterSection = content.substring(sectionEnd);
			const newContent = `${beforeSection}${header}\n\n${newSectionContent}\n\n${afterSection.trimStart()}`;

			// Update metadata
			const metadata = data as { updatedAt?: string };
			metadata.updatedAt = new Date().toISOString();

			// Write back
			const updatedFileContent = matter.stringify(newContent.trim(), data);
			await writeFile(resolved.filepath, updatedFileContent, "utf-8");

			// Notify server
			await notifyDocUpdate(resolved.filename);

			if (options.plain) {
				console.log(`Updated: ${resolved.filename}`);
				console.log(`Replaced section: "${header}"`);
			} else {
				console.log(chalk.green(`✓ Updated: ${resolved.filename}`));
				console.log(chalk.gray(`  Replaced section: "${header}"`));
			}
		} catch (error) {
			console.error(chalk.red("Error replacing section:"), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

// Main doc command
export const docCommand = new Command("doc")
	.description("Manage documentation")
	.argument("[name]", "Document name (shorthand for 'doc view <name>')")
	.option("--plain", "Plain text output for AI")
	.option("--info", "Show document stats (size, tokens, headings) without content")
	.option("--toc", "Show table of contents only")
	.option("--section <title>", "Show specific section by heading title or number")
	.option("--smart", "Smart mode: auto-return full content if small, or stats+TOC if large (>2000 tokens)")
	.enablePositionalOptions()
	.action(
		async (
			name: string | undefined,
			options: {
				plain?: boolean;
				info?: boolean;
				toc?: boolean;
				section?: string;
				smart?: boolean;
			},
		) => {
			// If no name provided, show help
			if (!name) {
				docCommand.help();
				return;
			}

			// Shorthand: `doc <name>` = `doc view <name>`
			try {
				const resolved = await resolveDocPath(name);
				if (!resolved) {
					console.error(chalk.red(`✗ Documentation not found: ${name}`));
					process.exit(1);
				}

				const { filepath, filename } = resolved;
				const fileContent = await readFile(filepath, "utf-8");
				const { data, content } = matter(fileContent);
				const metadata = data as DocMetadata;

				// Handle --smart option: auto-decide based on document size
				if (options.smart) {
					const stats = calculateDocStats(content);
					const SMART_THRESHOLD = 2000; // tokens

					if (stats.estimatedTokens <= SMART_THRESHOLD) {
						// Small doc: return full content (fall through to default behavior)
						// Don't return here, let it continue to the default content output
					} else {
						// Large doc: return stats + TOC
						const toc = extractToc(content);

						if (options.plain) {
							console.log(`Document: ${metadata.title}`);
							console.log("=".repeat(50));
							console.log();
							console.log(
								`Size: ${stats.chars.toLocaleString()} chars (~${stats.estimatedTokens.toLocaleString()} tokens)`,
							);
							console.log(`Headings: ${stats.headingCount}`);
							console.log();
							console.log("Table of Contents:");
							console.log("-".repeat(50));
							toc.forEach((entry, index) => {
								const indent = "  ".repeat(entry.level - 1);
								console.log(`${indent}${index + 1}. ${entry.title}`);
							});
							console.log();
							console.log("Document is large. Use --section <number> to read a specific section.");
						} else {
							console.log(chalk.bold(`\n📄 ${metadata.title} (Smart Mode)\n`));
							console.log(
								`Size: ${chalk.cyan(stats.chars.toLocaleString())} chars (~${chalk.yellow(stats.estimatedTokens.toLocaleString())} tokens)`,
							);
							console.log();
							console.log(chalk.bold("Table of Contents:"));
							console.log(formatToc(toc));
							console.log();
							console.log(chalk.yellow("⚠ Document is large. Use --section <number> to read a specific section."));
						}
						return;
					}
				}

				// Handle --info option
				if (options.info) {
					const stats = calculateDocStats(content);
					if (options.plain) {
						console.log(formatDocStats(stats, metadata.title));
					} else {
						console.log(chalk.bold(`\n📊 ${metadata.title} - Document Info\n`));
						console.log(
							`Size: ${chalk.cyan(stats.chars.toLocaleString())} chars (~${chalk.yellow(stats.estimatedTokens.toLocaleString())} tokens)`,
						);
						console.log(`Words: ${stats.words.toLocaleString()}`);
						console.log(`Lines: ${stats.lines.toLocaleString()}`);
						console.log(`Headings: ${stats.headingCount}`);
						console.log();
						if (stats.estimatedTokens > 4000) {
							console.log(chalk.yellow("⚠ Document is large. Use --toc first, then --section."));
						} else if (stats.estimatedTokens > 2000) {
							console.log(chalk.gray("Consider using --toc and --section for specific info."));
						} else {
							console.log(chalk.green("✓ Document is small enough to read directly."));
						}
						console.log();
					}
					return;
				}

				// Handle --toc option
				if (options.toc) {
					const toc = extractToc(content);
					if (toc.length === 0) {
						console.log(options.plain ? "No headings found." : chalk.yellow("No headings found in this document."));
						return;
					}

					if (options.plain) {
						console.log(`Table of Contents: ${metadata.title}`);
						console.log("=".repeat(50));
						console.log();
						toc.forEach((entry, index) => {
							const indent = "  ".repeat(entry.level - 1);
							console.log(`${indent}${index + 1}. ${entry.title}`);
						});
						console.log();
						console.log("Use --section <number or title> to view a specific section.");
					} else {
						console.log(chalk.bold(`\n📄 ${metadata.title} - Table of Contents\n`));
						console.log(formatToc(toc));
						console.log(chalk.gray("\nUse --section <number or title> to view a specific section."));
					}
					return;
				}

				// Handle --section option
				if (options.section) {
					// Check if section is a pure number (index from TOC display)
					const sectionIndex = /^\d+$/.test(options.section) ? Number.parseInt(options.section, 10) : null;
					const sectionContent =
						sectionIndex !== null
							? extractSectionByIndex(content, sectionIndex)
							: extractSection(content, options.section);
					if (!sectionContent) {
						console.error(
							options.plain
								? `Section not found: ${options.section}`
								: chalk.red(`✗ Section not found: ${options.section}`),
						);
						console.log(
							options.plain
								? "Use --toc to see available sections."
								: chalk.gray("Use --toc to see available sections."),
						);
						process.exit(1);
					}

					if (options.plain) {
						console.log(`File: ${process.cwd()}/.knowns/docs/${filename}`);
						console.log(`Section: ${options.section}`);
						console.log("=".repeat(50));
						console.log();
						console.log(sectionContent);
					} else {
						console.log(chalk.bold(`\n📄 ${metadata.title} - Section\n`));
						console.log(sectionContent);
						console.log();
					}
					return;
				}

				if (options.plain) {
					const border = "-".repeat(50);
					const titleBorder = "=".repeat(50);

					// File path
					const projectRoot = process.cwd();
					console.log(`File: ${projectRoot}/.knowns/docs/${filename}`);
					console.log();

					// Title
					console.log(metadata.title);
					console.log(titleBorder);
					console.log();

					// Metadata
					console.log(`Created: ${metadata.createdAt}`);
					console.log(`Updated: ${metadata.updatedAt}`);
					if (metadata.tags && metadata.tags.length > 0) {
						console.log(`Tags: ${metadata.tags.join(", ")}`);
					}

					// Description
					if (metadata.description) {
						console.log();
						console.log("Description:");
						console.log(border);
						console.log(metadata.description);
					}

					// Content with resolved links
					console.log();
					console.log("Content:");
					console.log(border);

					// Parse and enhance markdown links
					const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
					let enhancedContent = content.trimEnd();
					const linksToAdd: Array<{ original: string; resolved: string }> = [];

					let match: RegExpExecArray | null;
					// biome-ignore lint/suspicious/noAssignInExpressions: Standard regex iteration pattern
					while ((match = linkPattern.exec(content)) !== null) {
						const _linkText = match[1];
						const linkTarget = match[2];
						const fullMatch = match[0];

						// Skip external URLs
						if (linkTarget.startsWith("http://") || linkTarget.startsWith("https://")) {
							continue;
						}

						// Skip relative paths that go outside docs
						if (linkTarget.startsWith("../")) {
							continue;
						}

						// Normalize filename
						let resolvedFilename = linkTarget.replace(/^\.\//, "");
						if (!resolvedFilename.endsWith(".md")) {
							resolvedFilename = `${resolvedFilename}.md`;
						}

						const resolvedPath = `@.knowns/docs/${resolvedFilename}`;
						linksToAdd.push({
							original: fullMatch,
							resolved: resolvedPath,
						});
					}

					// Replace each link with resolved path only
					for (const { original, resolved } of linksToAdd) {
						enhancedContent = enhancedContent.replace(original, resolved);
					}

					console.log(enhancedContent);
				} else {
					console.log(chalk.bold(`\n📄 ${metadata.title}\n`));
					if (metadata.description) {
						console.log(chalk.gray(metadata.description));
						console.log();
					}
					if (metadata.tags && metadata.tags.length > 0) {
						console.log(chalk.gray(`Tags: ${metadata.tags.join(", ")}`));
					}
					console.log(chalk.gray(`Updated: ${new Date(metadata.updatedAt).toLocaleString()}`));
					console.log(chalk.gray("-".repeat(60)));
					console.log(content);
					console.log();
				}
			} catch (error) {
				console.error(
					chalk.red("Error viewing documentation:"),
					error instanceof Error ? error.message : String(error),
				);
				process.exit(1);
			}
		},
	);

// Add subcommands
docCommand.addCommand(createCommand);
docCommand.addCommand(listCommand);
docCommand.addCommand(viewCommand);
docCommand.addCommand(editCommand);
docCommand.addCommand(validateCommand);
docCommand.addCommand(repairCommand);
docCommand.addCommand(searchInCommand);
docCommand.addCommand(replaceCommand);
docCommand.addCommand(replaceSectionCommand);
