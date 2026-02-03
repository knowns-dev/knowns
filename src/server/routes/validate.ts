/**
 * Validate routes module - SDD stats endpoint
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type Request, type Response, Router } from "express";
import matter from "gray-matter";
import type { RouteContext } from "../types";

interface SDDStats {
	specs: { total: number; approved: number; draft: number; implemented: number };
	tasks: { total: number; done: number; inProgress: number; todo: number; withSpec: number; withoutSpec: number };
	coverage: { linked: number; total: number; percent: number };
	acCompletion: Record<string, { total: number; completed: number; percent: number }>;
}

interface SDDWarning {
	type: "task-no-spec" | "spec-broken-link" | "spec-ac-incomplete";
	entity: string;
	message: string;
}

interface SDDResult {
	stats: SDDStats;
	warnings: SDDWarning[];
	passed: string[];
}

export function createValidateRoutes(ctx: RouteContext): Router {
	const router = Router();
	const { store } = ctx;

	// GET /api/validate/sdd - Get SDD stats
	router.get("/sdd", async (_req: Request, res: Response) => {
		try {
			const tasks = await store.getAllTasks();
			const docsDir = join(store.projectRoot, ".knowns", "docs");

			// Initialize stats
			const stats: SDDStats = {
				specs: { total: 0, approved: 0, draft: 0, implemented: 0 },
				tasks: { total: tasks.length, done: 0, inProgress: 0, todo: 0, withSpec: 0, withoutSpec: 0 },
				coverage: { linked: 0, total: tasks.length, percent: 0 },
				acCompletion: {},
			};

			const warnings: SDDWarning[] = [];
			const passed: string[] = [];

			// Count task statuses
			for (const task of tasks) {
				if (task.status === "done") stats.tasks.done++;
				else if (task.status === "in-progress") stats.tasks.inProgress++;
				else stats.tasks.todo++;

				if (task.spec) {
					stats.tasks.withSpec++;
				} else {
					stats.tasks.withoutSpec++;
					// Only add warning for non-done tasks
					if (task.status !== "done") {
						warnings.push({
							type: "task-no-spec",
							entity: `task-${task.id}`,
							message: `${task.title} has no spec reference`,
						});
					}
				}
			}

			stats.coverage.linked = stats.tasks.withSpec;
			stats.coverage.percent = stats.tasks.total > 0 ? Math.round((stats.tasks.withSpec / stats.tasks.total) * 100) : 0;

			// Scan specs folder for spec documents
			const specsDir = join(docsDir, "specs");
			if (existsSync(specsDir)) {
				async function scanSpecs(dir: string, relativePath: string) {
					const entries = await readdir(dir, { withFileTypes: true });
					for (const entry of entries) {
						if (entry.name.startsWith(".")) continue;
						const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
						if (entry.isDirectory()) {
							await scanSpecs(join(dir, entry.name), entryRelPath);
						} else if (entry.name.endsWith(".md")) {
							stats.specs.total++;
							const specPath = `specs/${entryRelPath.replace(/\.md$/, "")}`;

							try {
								const content = await readFile(join(dir, entry.name), "utf-8");
								const { data } = matter(content);

								// Check spec status
								if (data.status === "implemented") {
									stats.specs.implemented++;
								} else if (data.status === "approved") {
									stats.specs.approved++;
								} else {
									stats.specs.draft++;
								}

								// Calculate AC completion for tasks linked to this spec
								const linkedTasks = tasks.filter((t) => t.spec === specPath);
								if (linkedTasks.length > 0) {
									let totalAC = 0;
									let completedAC = 0;
									for (const task of linkedTasks) {
										totalAC += task.acceptanceCriteria.length;
										completedAC += task.acceptanceCriteria.filter((ac) => ac.completed).length;
									}
									const percent = totalAC > 0 ? Math.round((completedAC / totalAC) * 100) : 100;
									stats.acCompletion[specPath] = { total: totalAC, completed: completedAC, percent };

									if (percent < 100 && totalAC > 0) {
										warnings.push({
											type: "spec-ac-incomplete",
											entity: specPath,
											message: `${completedAC}/${totalAC} ACs complete (${percent}%)`,
										});
									}
								}
							} catch {
								// Skip files that can't be parsed
							}
						}
					}
				}
				await scanSpecs(specsDir, "");
			}

			// Validate spec links in tasks
			for (const task of tasks) {
				if (task.spec) {
					const specDocPath = join(docsDir, `${task.spec}.md`);
					if (!existsSync(specDocPath)) {
						warnings.push({
							type: "spec-broken-link",
							entity: `task-${task.id}`,
							message: `Broken spec reference: @doc/${task.spec}`,
						});
					}
				}
			}

			// Generate passed messages
			if (warnings.filter((w) => w.type === "spec-broken-link").length === 0) {
				passed.push("All spec references resolve");
			}

			// Check for fully implemented specs
			for (const [specPath, completion] of Object.entries(stats.acCompletion)) {
				if (completion.percent === 100) {
					passed.push(`${specPath}: fully implemented`);
				}
			}

			const result: SDDResult = { stats, warnings, passed };
			res.json(result);
		} catch (error) {
			console.error("Error getting SDD stats:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	return router;
}
