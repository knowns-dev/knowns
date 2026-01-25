/**
 * Config routes module
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImportConfig } from "@import/models";
import { type Request, type Response, Router } from "express";
import type { RouteContext } from "../types";

export function createConfigRoutes(ctx: RouteContext): Router {
	const router = Router();
	const { store } = ctx;
	const configPath = join(store.projectRoot, ".knowns", "config.json");

	// GET /api/config
	router.get("/", async (_req: Request, res: Response) => {
		try {
			if (!existsSync(configPath)) {
				res.json({
					config: {
						name: "Knowns",
						defaultPriority: "medium",
						defaultLabels: [],
						timeFormat: "24h",
						visibleColumns: ["todo", "in-progress", "done"],
					},
				});
				return;
			}

			const content = await readFile(configPath, "utf-8");
			const data = JSON.parse(content);
			const settings = data.settings || {};

			// Merge root-level properties (name, id, createdAt, imports) with settings
			const config = {
				name: data.name,
				id: data.id,
				createdAt: data.createdAt,
				imports: data.imports,
				...settings,
			};

			// Ensure visibleColumns exists with default value
			if (!config.visibleColumns) {
				config.visibleColumns = ["todo", "in-progress", "done"];
			}

			res.json({ config });
		} catch (error) {
			console.error("Error getting config:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/config
	router.post("/", async (req: Request, res: Response) => {
		try {
			const config = req.body;

			// Read existing file to preserve project metadata and imports
			let existingData: {
				name?: string;
				id?: string;
				createdAt?: string;
				imports?: ImportConfig[];
				settings?: Record<string, unknown>;
			} = {};
			if (existsSync(configPath)) {
				const content = await readFile(configPath, "utf-8");
				existingData = JSON.parse(content);
			}

			// Extract root-level fields from request, put rest into settings
			const { name, imports, id, createdAt, ...settings } = config;

			// Merge: update root-level fields if provided, update settings
			const merged = {
				...existingData,
				name: name || existingData.name,
				id: id || existingData.id,
				createdAt: createdAt || existingData.createdAt,
				imports: imports !== undefined ? imports : existingData.imports,
				settings: settings,
			};

			await writeFile(configPath, JSON.stringify(merged, null, 2), "utf-8");

			res.json({ success: true });
		} catch (error) {
			console.error("Error saving config:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	return router;
}
