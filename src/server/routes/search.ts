/**
 * Search routes module
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Request, type Response, Router } from "express";
import matter from "gray-matter";
import type { DocResult, RouteContext } from "../types";
import { findMarkdownFiles } from "../utils/markdown";

export function createSearchRoutes(ctx: RouteContext): Router {
	const router = Router();
	const { store } = ctx;

	// GET /api/search
	router.get("/", async (req: Request, res: Response) => {
		try {
			const query = req.query.q as string;
			if (!query) {
				res.json({ tasks: [], docs: [] });
				return;
			}

			const q = query.toLowerCase();

			// Search tasks
			const allTasks = await store.getAllTasks();
			const taskResults = allTasks.filter((task) => {
				const searchText = [
					task.id,
					task.title,
					task.description || "",
					task.implementationPlan || "",
					task.implementationNotes || "",
					...task.labels,
					task.assignee || "",
				]
					.join(" ")
					.toLowerCase();

				return searchText.includes(q);
			});

			// Search docs (including nested folders)
			const docsDir = join(store.projectRoot, ".knowns", "docs");
			const docResults: DocResult[] = [];

			if (existsSync(docsDir)) {
				const mdFiles = await findMarkdownFiles(docsDir, docsDir);

				for (const relativePath of mdFiles) {
					const fullPath = join(docsDir, relativePath);
					const content = await readFile(fullPath, "utf-8");
					const { data, content: docContent } = matter(content);

					const searchText =
						`${data.title || ""} ${data.description || ""} ${data.tags?.join(" ") || ""} ${docContent}`.toLowerCase();

					if (searchText.includes(q)) {
						const pathParts = relativePath.split("/");
						const filename = pathParts[pathParts.length - 1];
						const folder = pathParts.length > 1 ? pathParts.slice(0, -1).join("/") : "";

						docResults.push({
							filename,
							path: relativePath,
							folder,
							metadata: data,
							content: docContent,
						});
					}
				}
			}

			res.json({ tasks: taskResults, docs: docResults });
		} catch (error) {
			console.error("Error searching:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	return router;
}
