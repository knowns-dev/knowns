/**
 * Import routes module
 * REST API for importing templates/docs from external sources
 */

import { type Request, type Response, Router } from "express";
import {
	ImportError,
	type ImportType,
	getImportsWithMetadata,
	importSource,
	removeImport,
	syncAllImports,
	syncImport,
} from "../../import";
import type { RouteContext } from "../types";

export function createImportRoutes(ctx: RouteContext): Router {
	const router = Router();
	const { store, broadcast } = ctx;

	// GET /api/imports - List all imports
	router.get("/", async (_req: Request, res: Response) => {
		try {
			const imports = await getImportsWithMetadata(store.projectRoot);

			const importList = imports.map((imp) => ({
				name: imp.config.name,
				source: imp.config.source,
				type: imp.config.type,
				ref: imp.config.ref,
				link: imp.config.link || false,
				autoSync: imp.config.autoSync ?? false,
				lastSync: imp.metadata?.lastSync,
				fileCount: imp.metadata?.files.length || 0,
				importedAt: imp.metadata?.importedAt,
			}));

			res.json({ imports: importList, count: importList.length });
		} catch (error) {
			console.error("Error listing imports:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// GET /api/imports/:name - Get import details
	router.get("/:name", async (req: Request, res: Response) => {
		try {
			const { name } = req.params;
			const imports = await getImportsWithMetadata(store.projectRoot);
			const imp = imports.find((i) => i.config.name === name);

			if (!imp) {
				res.status(404).json({ error: `Import not found: ${name}` });
				return;
			}

			res.json({
				import: {
					name: imp.config.name,
					source: imp.config.source,
					type: imp.config.type,
					ref: imp.config.ref,
					link: imp.config.link || false,
					autoSync: imp.config.autoSync ?? false,
					include: imp.config.include,
					exclude: imp.config.exclude,
					lastSync: imp.metadata?.lastSync,
					importedAt: imp.metadata?.importedAt,
					commit: imp.metadata?.commit,
					version: imp.metadata?.version,
					files: imp.metadata?.files || [],
					fileCount: imp.metadata?.files.length || 0,
				},
			});
		} catch (error) {
			console.error("Error getting import:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/imports - Add new import
	router.post("/", async (req: Request, res: Response) => {
		try {
			const { source, name, type, ref, include, exclude, link, force, dryRun } = req.body;

			if (!source) {
				res.status(400).json({ error: "Source is required" });
				return;
			}

			const result = await importSource(store.projectRoot, source, {
				name,
				type: type as ImportType | undefined,
				ref,
				include,
				exclude,
				link,
				force,
				dryRun,
			});

			if (!result.success) {
				res.status(500).json({ error: result.error });
				return;
			}

			// Broadcast event if not dry run
			if (!dryRun) {
				broadcast({ type: "imports:added", import: result.name, source: result.source });
			}

			// Format changes
			const changes = result.changes.map((c) => ({
				path: c.path,
				action: c.action,
				skipReason: c.skipReason,
			}));

			res.status(201).json({
				success: true,
				dryRun: dryRun || false,
				import: {
					name: result.name,
					source: result.source,
					type: result.type,
				},
				changes,
				summary: {
					added: changes.filter((c) => c.action === "add").length,
					updated: changes.filter((c) => c.action === "update").length,
					skipped: changes.filter((c) => c.action === "skip").length,
				},
			});
		} catch (error) {
			if (error instanceof ImportError) {
				res.status(400).json({
					error: error.message,
					code: error.code,
					hint: error.hint,
				});
				return;
			}
			console.error("Error adding import:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/imports/:name/sync - Sync single import
	router.post("/:name/sync", async (req: Request, res: Response) => {
		try {
			const { name } = req.params;
			const { force, dryRun } = req.body;

			const result = await syncImport(store.projectRoot, name, {
				force,
				dryRun,
			});

			if (!result.success) {
				res.status(500).json({ error: result.error });
				return;
			}

			// Broadcast event if not dry run
			if (!dryRun && result.changes.length > 0) {
				broadcast({ type: "imports:synced", import: result.name });
			}

			// Format changes
			const changes = result.changes.map((c) => ({
				path: c.path,
				action: c.action,
				skipReason: c.skipReason,
			}));

			// Check for locally modified files
			const modifiedLocally = changes.filter((c) => c.skipReason === "Local modifications detected");

			res.json({
				success: true,
				dryRun: dryRun || false,
				import: {
					name: result.name,
					source: result.source,
					type: result.type,
				},
				changes,
				summary: {
					added: changes.filter((c) => c.action === "add").length,
					updated: changes.filter((c) => c.action === "update").length,
					skipped: changes.filter((c) => c.action === "skip").length,
					modifiedLocally: modifiedLocally.length,
				},
				warnings:
					modifiedLocally.length > 0
						? [`${modifiedLocally.length} locally modified files were skipped. Use force to overwrite.`]
						: [],
			});
		} catch (error) {
			if (error instanceof ImportError) {
				res.status(400).json({
					error: error.message,
					code: error.code,
					hint: error.hint,
				});
				return;
			}
			console.error("Error syncing import:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/imports/sync-all - Sync all imports
	router.post("/sync-all", async (req: Request, res: Response) => {
		try {
			const { force, dryRun } = req.body;

			const results = await syncAllImports(store.projectRoot, {
				force,
				dryRun,
			});

			// Broadcast event if not dry run
			if (!dryRun) {
				const synced = results.filter((r) => r.success && r.changes.length > 0).length;
				if (synced > 0) {
					broadcast({ type: "imports:sync-all", count: synced });
				}
			}

			// Format results
			const formatted = results.map((r) => ({
				name: r.name,
				source: r.source,
				type: r.type,
				success: r.success,
				error: r.error,
				summary: r.success
					? {
							added: r.changes.filter((c) => c.action === "add").length,
							updated: r.changes.filter((c) => c.action === "update").length,
							skipped: r.changes.filter((c) => c.action === "skip").length,
						}
					: undefined,
			}));

			res.json({
				success: true,
				dryRun: dryRun || false,
				results: formatted,
				summary: {
					total: results.length,
					successful: results.filter((r) => r.success).length,
					failed: results.filter((r) => !r.success).length,
				},
			});
		} catch (error) {
			console.error("Error syncing all imports:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// DELETE /api/imports/:name - Remove import
	router.delete("/:name", async (req: Request, res: Response) => {
		try {
			const { name } = req.params;
			const deleteFiles = req.query.delete === "true";

			const result = await removeImport(store.projectRoot, name, deleteFiles);

			broadcast({ type: "imports:removed", import: name, filesDeleted: result.deleted });

			res.json({
				success: true,
				import: name,
				filesDeleted: result.deleted,
				message: result.deleted
					? `Removed import "${name}" and deleted files`
					: `Removed import "${name}" (files kept)`,
			});
		} catch (error) {
			if (error instanceof ImportError) {
				res.status(400).json({
					error: error.message,
					code: error.code,
					hint: error.hint,
				});
				return;
			}
			console.error("Error removing import:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	return router;
}
