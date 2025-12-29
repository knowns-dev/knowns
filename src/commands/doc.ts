/**
 * Documentation management commands
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { FileStore } from "@storage/file-store";
import { findProjectRoot } from "@utils/find-project-root";
import { buildTaskMap, normalizeRefs, transformMentionsToRefs } from "@utils/mention-refs";
import { notifyDocUpdate } from "@utils/notify-server";
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
		const relativePath = basePath ? join(basePath, entry.name) : entry.name;

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
	.action(async (title: string, options: { description?: string; tags?: string; folder?: string; plain?: boolean }) => {
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
			console.error(chalk.red("Error creating documentation:"), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

// List command
const listCommand = new Command("list")
	.description("List all documentation files")
	.option("--plain", "Plain text output for AI")
	.option("-t, --tag <tag>", "Filter by tag")
	.action(async (options: { plain?: boolean; tag?: string }) => {
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

			const docs: Array<{ filename: string; metadata: DocMetadata }> = [];

			for (const file of mdFiles) {
				const content = await readFile(join(DOCS_DIR, file), "utf-8");
				const { data } = matter(content);
				docs.push({
					filename: file,
					metadata: data as DocMetadata,
				});
			}

			// Filter by tag if specified
			let filteredDocs = docs;
			if (options.tag) {
				filteredDocs = docs.filter((doc) => doc.metadata.tags?.includes(options.tag));
			}

			if (filteredDocs.length === 0) {
				console.log(
					options.plain ? "No documentation found" : chalk.yellow(`No documentation found with tag: ${options.tag}`),
				);
				return;
			}

			if (options.plain) {
				const border = "=".repeat(50);
				console.log(`Documentation Files (${filteredDocs.length})`);
				console.log(border);
				console.log();

				for (const doc of filteredDocs) {
					console.log(`${doc.filename} - ${doc.metadata.title}`);
					if (doc.metadata.description) {
						console.log(`  ${doc.metadata.description}`);
					}
					console.log(`  Created: ${doc.metadata.createdAt}`);
					if (doc.metadata.tags && doc.metadata.tags.length > 0) {
						console.log(`  Tags: ${doc.metadata.tags.join(", ")}`);
					}
					console.log();
				}
			} else {
				console.log(chalk.bold("\n📚 Documentation\n"));
				for (const doc of filteredDocs) {
					console.log(chalk.cyan(`  ${doc.metadata.title}`));
					if (doc.metadata.description) {
						console.log(chalk.gray(`    ${doc.metadata.description}`));
					}
					console.log(chalk.gray(`    File: ${doc.filename}`));
					if (doc.metadata.tags && doc.metadata.tags.length > 0) {
						console.log(chalk.gray(`    Tags: ${doc.metadata.tags.join(", ")}`));
					}
					console.log(chalk.gray(`    Updated: ${new Date(doc.metadata.updatedAt).toLocaleString()}`));
					console.log();
				}
				console.log(chalk.gray(`Total: ${filteredDocs.length} document(s)\n`));
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
	.action(async (name: string, options: { plain?: boolean }) => {
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

				// Transform @task-{id} and @doc/{path} mentions
				const knownProjectRoot = findProjectRoot();
				if (knownProjectRoot) {
					const fileStore = new FileStore(knownProjectRoot);
					const allTasks = await fileStore.getAllTasks();
					const taskMap = buildTaskMap(allTasks);
					enhancedContent = transformMentionsToRefs(enhancedContent, taskMap);
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
			console.error(chalk.red("Error viewing documentation:"), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

// Edit command
const editCommand = new Command("edit")
	.description("Edit a documentation file (metadata and content)")
	.argument("<name>", "Document name or path (e.g., guides/my-doc)")
	.option("-t, --title <text>", "New title")
	.option("-d, --description <text>", "New description")
	.option("--tags <tags>", "Comma-separated tags")
	.option("-c, --content <text>", "Replace content")
	.option("-a, --append <text>", "Append to content")
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
				if (options.content) {
					updatedContent = normalizeRefs(options.content);
				}
				if (options.append) {
					updatedContent = `${content.trimEnd()}\n\n${normalizeRefs(options.append)}`;
				}

				// Write back
				const newFileContent = matter.stringify(updatedContent, metadata);
				await writeFile(filepath, newFileContent, "utf-8");

				// Notify web server for real-time updates
				await notifyDocUpdate(filename);

				if (options.plain) {
					console.log(`Updated: ${filename}`);
				} else {
					console.log(chalk.green(`✓ Updated documentation: ${chalk.bold(filename)}`));
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

// Main doc command
export const docCommand = new Command("doc")
	.description("Manage documentation")
	.argument("[name]", "Document name (shorthand for 'doc view <name>')")
	.option("--plain", "Plain text output for AI")
	.action(async (name: string | undefined, options: { plain?: boolean }) => {
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

				// Transform @task-{id} and @doc/{path} mentions
				const knownProjectRoot = findProjectRoot();
				if (knownProjectRoot) {
					const fileStore = new FileStore(knownProjectRoot);
					const allTasks = await fileStore.getAllTasks();
					const taskMap = buildTaskMap(allTasks);
					enhancedContent = transformMentionsToRefs(enhancedContent, taskMap);
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
			console.error(chalk.red("Error viewing documentation:"), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

// Add subcommands
docCommand.addCommand(createCommand);
docCommand.addCommand(listCommand);
docCommand.addCommand(viewCommand);
docCommand.addCommand(editCommand);
