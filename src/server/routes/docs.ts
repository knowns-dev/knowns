/**
 * Documentation routes module
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Request, type Response, Router } from "express";
import matter from "gray-matter";
import type { DocResult, RouteContext } from "../types";
import { findMarkdownFiles } from "../utils/markdown";

export function createDocRoutes(ctx: RouteContext): Router {
	const router = Router();
	const { store, broadcast } = ctx;
	const docsDir = join(store.projectRoot, ".knowns", "docs");

	// GET /api/docs - List all docs
	router.get("/", async (_req: Request, res: Response) => {
		try {
			if (!existsSync(docsDir)) {
				res.json({ docs: [] });
				return;
			}

			const mdFiles = await findMarkdownFiles(docsDir, docsDir);

			const docs: DocResult[] = await Promise.all(
				mdFiles.map(async (relativePath) => {
					const fullPath = join(docsDir, relativePath);
					const content = await readFile(fullPath, "utf-8");
					const { data, content: docContent } = matter(content);

					const pathParts = relativePath.split("/");
					const filename = pathParts[pathParts.length - 1];
					const folder = pathParts.length > 1 ? pathParts.slice(0, -1).join("/") : "";

					return {
						filename,
						path: relativePath,
						folder,
						metadata: data,
						content: docContent,
					};
				}),
			);

			res.json({ docs });
		} catch (error) {
			console.error("Error getting docs:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// GET /api/docs/:path - Get single doc by path (supports nested paths)
	router.get("/{*path}", async (req: Request, res: Response) => {
		try {
			const docPath = Array.isArray(req.params.path) ? req.params.path.join("/") : req.params.path;
			const fullPath = join(docsDir, docPath);

			// Security: ensure path doesn't escape docs directory
			if (!fullPath.startsWith(docsDir)) {
				res.status(400).json({ error: "Invalid path" });
				return;
			}

			if (!existsSync(fullPath)) {
				res.status(404).json({ error: "Document not found" });
				return;
			}

			const content = await readFile(fullPath, "utf-8");
			const { data, content: docContent } = matter(content);

			const pathParts = docPath.split("/");
			const filename = pathParts[pathParts.length - 1];
			const folder = pathParts.length > 1 ? pathParts.slice(0, -1).join("/") : "";

			const doc = {
				filename,
				path: docPath,
				folder,
				title: data.title || filename.replace(/\.md$/, ""),
				description: data.description || "",
				tags: data.tags || [],
				metadata: data,
				content: docContent,
			};

			res.json(doc);
		} catch (error) {
			console.error("Error getting doc:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/docs - Create doc
	router.post("/", async (req: Request, res: Response) => {
		try {
			// Ensure docs directory exists
			if (!existsSync(docsDir)) {
				await mkdir(docsDir, { recursive: true });
			}

			const data = req.body;
			const { title, description, tags, content, folder } = data;

			if (!title) {
				res.status(400).json({ error: "Title is required" });
				return;
			}

			// Create filename from title
			const filename = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;

			// Construct full path with folder
			let filepath: string;
			let targetDir: string;

			if (folder?.trim()) {
				const cleanFolder = folder.trim().replace(/^\/+|\/+$/g, "");
				targetDir = join(docsDir, cleanFolder);
				filepath = join(targetDir, filename);
			} else {
				targetDir = docsDir;
				filepath = join(docsDir, filename);
			}

			// Create target directory if it doesn't exist
			if (!existsSync(targetDir)) {
				await mkdir(targetDir, { recursive: true });
			}

			// Check if file already exists
			if (existsSync(filepath)) {
				res.status(409).json({ error: "Document with this title already exists in this folder" });
				return;
			}

			// Create frontmatter
			const now = new Date().toISOString();
			const frontmatter = {
				title,
				description: description || "",
				createdAt: now,
				updatedAt: now,
				tags: tags || [],
			};

			// Create markdown file with frontmatter
			const markdown = matter.stringify(content || "", frontmatter);
			await writeFile(filepath, markdown, "utf-8");

			res.status(201).json({
				success: true,
				filename,
				folder: folder || "",
				path: folder ? `${folder}/${filename}` : filename,
				metadata: frontmatter,
			});
		} catch (error) {
			console.error("Error creating doc:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// PUT /api/docs/:path - Update existing doc (supports nested paths)
	router.put("/{*path}", async (req: Request, res: Response) => {
		try {
			const docPath = Array.isArray(req.params.path) ? req.params.path.join("/") : req.params.path;
			const fullPath = join(docsDir, docPath);

			// Security: ensure path doesn't escape docs directory
			if (!fullPath.startsWith(docsDir)) {
				res.status(400).json({ error: "Invalid path" });
				return;
			}

			if (!existsSync(fullPath)) {
				res.status(404).json({ error: "Document not found" });
				return;
			}

			const data = req.body;
			const { content, title, description, tags } = data;

			// Read existing file to get current frontmatter
			const existingContent = await readFile(fullPath, "utf-8");
			const { data: existingData } = matter(existingContent);

			// Update frontmatter
			const now = new Date().toISOString();
			const updatedFrontmatter = {
				...existingData,
				title: title ?? existingData.title,
				description: description ?? existingData.description,
				tags: tags ?? existingData.tags,
				updatedAt: now,
			};

			// Create new file content
			const newFileContent = matter.stringify(content ?? "", updatedFrontmatter);
			await writeFile(fullPath, newFileContent, "utf-8");

			// Return updated doc
			const pathParts = docPath.split("/");
			const filename = pathParts[pathParts.length - 1];
			const folder = pathParts.length > 1 ? pathParts.slice(0, -1).join("/") : "";

			const updatedDoc = {
				filename,
				path: docPath,
				folder,
				title: updatedFrontmatter.title || filename.replace(/\.md$/, ""),
				description: updatedFrontmatter.description || "",
				tags: updatedFrontmatter.tags || [],
				metadata: updatedFrontmatter,
				content: content ?? "",
			};

			broadcast({ type: "docs:updated", doc: updatedDoc });
			res.json(updatedDoc);
		} catch (error) {
			console.error("Error updating doc:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	return router;
}
