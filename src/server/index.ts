/**
 * Local Server
 * Serves Web UI via `knowns browser`
 * Uses Express + ws for Node.js compatibility
 */

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { FileStore } from "@storage/file-store";
import cors from "cors";
import express, { type Request, type Response } from "express";
import matter from "gray-matter";
import { type WebSocket, WebSocketServer } from "ws";

// Check if running in Bun
const isBun = typeof globalThis.Bun !== "undefined";

interface ServerOptions {
	port: number;
	projectRoot: string;
	open: boolean;
}

interface DocResult {
	filename: string;
	path: string;
	folder: string;
	metadata: Record<string, unknown>;
	content: string;
}

export async function startServer(options: ServerOptions) {
	const { port, projectRoot, open } = options;
	const store = new FileStore(projectRoot);

	// Track WebSocket clients
	const clients = new Set<WebSocket>();

	// Broadcast to all connected clients
	const broadcast = (data: object) => {
		const msg = JSON.stringify(data);
		for (const client of clients) {
			if (client.readyState === 1) {
				// WebSocket.OPEN
				client.send(msg);
			}
		}
	};

	// Find the UI files in the installed package
	// Use realpathSync to resolve symlinks (bun creates symlinks in ~/.bun/bin/)
	const currentFile = realpathSync(fileURLToPath(import.meta.url));
	const currentDir = dirname(currentFile);

	// Try to find package root by checking parent directories
	let packageRoot = currentDir;

	// Normalize: remove trailing slashes for consistent checking
	const normalizedDir = currentDir.replace(/[/\\]+$/, "");
	const dirName = basename(normalizedDir);

	// If we're in dist/ folder (bundled), go up 1 level to package root
	if (dirName === "dist") {
		packageRoot = join(currentDir, "..");
	}
	// If we're in src/server (development), go up 2 levels to package root
	else if (normalizedDir.includes("/src/server") || normalizedDir.includes("\\src\\server")) {
		packageRoot = join(currentDir, "..", "..");
	}

	const uiDistPath = join(packageRoot, "dist", "ui");

	// Check if UI build exists
	if (!existsSync(join(uiDistPath, "index.html"))) {
		throw new Error(`UI build not found at ${uiDistPath}. Run 'bun run build:ui' first.`);
	}

	// Create Express app
	const app = express();
	app.use(cors());
	app.use(express.json());

	// Create HTTP server
	const httpServer = createServer(app);

	// Create WebSocket server
	const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

	wss.on("connection", (ws) => {
		clients.add(ws);

		ws.on("close", () => {
			clients.delete(ws);
		});

		ws.on("error", (error) => {
			console.error("WebSocket error:", error);
			clients.delete(ws);
		});
	});

	// Serve static assets from Vite build (assets folder with hashed names)
	app.use(
		"/assets",
		express.static(join(uiDistPath, "assets"), {
			maxAge: "1y",
			immutable: true,
		}),
	);

	// API Routes
	// GET /api/tasks
	app.get("/api/tasks", async (_req: Request, res: Response) => {
		try {
			const tasks = await store.getAllTasks();
			res.json(tasks);
		} catch (error) {
			console.error("Error getting tasks:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// GET /api/tasks/:id/history
	app.get("/api/tasks/:id/history", async (req: Request, res: Response) => {
		try {
			const taskId = req.params.id;
			const history = await store.getTaskVersionHistory(taskId);
			res.json({ versions: history });
		} catch (error) {
			console.error("Error getting task history:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// GET /api/tasks/:id
	app.get("/api/tasks/:id", async (req: Request, res: Response) => {
		try {
			const task = await store.getTask(req.params.id);
			if (!task) {
				res.status(404).json({ error: "Task not found" });
				return;
			}
			res.json(task);
		} catch (error) {
			console.error("Error getting task:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// PUT /api/tasks/:id
	app.put("/api/tasks/:id", async (req: Request, res: Response) => {
		try {
			const updates = req.body;
			const task = await store.updateTask(req.params.id, updates);

			// Broadcast update to all clients
			broadcast({ type: "tasks:updated", task });

			res.json(task);
		} catch (error) {
			console.error("Error updating task:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/tasks
	app.post("/api/tasks", async (req: Request, res: Response) => {
		try {
			const data = req.body;
			const task = await store.createTask(data);

			// Broadcast new task to all clients
			broadcast({ type: "tasks:updated", task });

			res.status(201).json(task);
		} catch (error) {
			console.error("Error creating task:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/notify - CLI notifies server about task/doc changes
	app.post("/api/notify", async (req: Request, res: Response) => {
		try {
			const { taskId, type, docPath } = req.body;

			if (taskId) {
				// Reload task from disk and broadcast
				const task = await store.getTask(taskId);
				if (task) {
					broadcast({ type: "tasks:updated", task });
					res.json({ success: true });
					return;
				}
			} else if (type === "tasks:refresh") {
				// Broadcast refresh signal to reload all tasks
				broadcast({ type: "tasks:refresh" });
				res.json({ success: true });
				return;
			} else if (type === "docs:updated" && docPath) {
				// Broadcast doc update
				broadcast({ type: "docs:updated", docPath });
				res.json({ success: true });
				return;
			} else if (type === "docs:refresh") {
				// Broadcast docs refresh signal
				broadcast({ type: "docs:refresh" });
				res.json({ success: true });
				return;
			}

			res.status(400).json({ success: false, error: "Invalid notify request" });
		} catch (error) {
			console.error("[Server] Notify error:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// GET /api/docs
	app.get("/api/docs", async (_req: Request, res: Response) => {
		try {
			const docsDir = join(store.projectRoot, ".knowns", "docs");

			if (!existsSync(docsDir)) {
				res.json({ docs: [] });
				return;
			}

			// Recursively find all .md files
			const mdFiles = await findMarkdownFiles(docsDir, docsDir);

			const docs = await Promise.all(
				mdFiles.map(async (relativePath) => {
					const fullPath = join(docsDir, relativePath);
					const content = await readFile(fullPath, "utf-8");
					const { data, content: docContent } = matter(content);

					// Extract folder path and filename
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
	app.get("/api/docs/{*path}", async (req: Request, res: Response) => {
		try {
			// Express 5 wildcard returns array, join to get path string
			const docPath = Array.isArray(req.params.path) ? req.params.path.join("/") : req.params.path;
			const docsDir = join(store.projectRoot, ".knowns", "docs");
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

			// Extract folder path and filename
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

	// PUT /api/docs/:path - Update existing doc (supports nested paths)
	app.put("/api/docs/{*path}", async (req: Request, res: Response) => {
		try {
			// Express 5 wildcard returns array, join to get path string
			const docPath = Array.isArray(req.params.path) ? req.params.path.join("/") : req.params.path;
			const docsDir = join(store.projectRoot, ".knowns", "docs");
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

			// Write file
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

			// Broadcast update to all clients
			broadcast({ type: "docs:updated", doc: updatedDoc });

			res.json(updatedDoc);
		} catch (error) {
			console.error("Error updating doc:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/docs
	app.post("/api/docs", async (req: Request, res: Response) => {
		try {
			const docsDir = join(store.projectRoot, ".knowns", "docs");

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
				// Clean folder path (remove leading/trailing slashes)
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

	// GET /api/config
	app.get("/api/config", async (_req: Request, res: Response) => {
		try {
			const configPath = join(store.projectRoot, ".knowns", "config.json");

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

			// Merge root-level properties (name, id, createdAt) with settings
			const config = {
				name: data.name,
				id: data.id,
				createdAt: data.createdAt,
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
	app.post("/api/config", async (req: Request, res: Response) => {
		try {
			const config = req.body;
			const configPath = join(store.projectRoot, ".knowns", "config.json");

			// Read existing file to preserve project metadata
			let existingData: { name?: string; id?: string; createdAt?: string; settings?: Record<string, unknown> } = {};
			if (existsSync(configPath)) {
				const content = await readFile(configPath, "utf-8");
				existingData = JSON.parse(content);
			}

			// Extract name if provided, put it at top level
			const { name, ...settings } = config;

			// Merge: update name if provided, update settings
			const merged = {
				...existingData,
				name: name || existingData.name,
				settings: settings,
			};

			await writeFile(configPath, JSON.stringify(merged, null, 2), "utf-8");

			res.json({ success: true });
		} catch (error) {
			console.error("Error saving config:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// GET /api/activities
	app.get("/api/activities", async (req: Request, res: Response) => {
		try {
			const limit = Number.parseInt((req.query.limit as string) || "50", 10);
			const type = req.query.type as string | undefined;

			const tasks = await store.getAllTasks();
			const allActivities: Array<{
				taskId: string;
				taskTitle: string;
				version: number;
				timestamp: Date;
				author?: string;
				changes: Array<{ field: string; oldValue: unknown; newValue: unknown }>;
			}> = [];

			// Collect version history from all tasks
			for (const task of tasks) {
				const versions = await store.getTaskVersionHistory(task.id);
				for (const version of versions) {
					// Filter by change type if specified
					if (type) {
						const hasMatchingChange = version.changes.some((c) => c.field === type);
						if (!hasMatchingChange) continue;
					}

					allActivities.push({
						taskId: task.id,
						taskTitle: task.title,
						version: version.version,
						timestamp: version.timestamp,
						author: version.author,
						changes: version.changes,
					});
				}
			}

			// Sort by timestamp descending (most recent first)
			allActivities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

			// Limit results
			const limited = allActivities.slice(0, limit);

			res.json({ activities: limited });
		} catch (error) {
			console.error("Error getting activities:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// GET /api/search
	app.get("/api/search", async (req: Request, res: Response) => {
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
				// Recursively find all .md files
				const mdFiles = await findMarkdownFiles(docsDir, docsDir);

				for (const relativePath of mdFiles) {
					const fullPath = join(docsDir, relativePath);
					const content = await readFile(fullPath, "utf-8");
					const { data, content: docContent } = matter(content);

					const searchText =
						`${data.title || ""} ${data.description || ""} ${data.tags?.join(" ") || ""} ${docContent}`.toLowerCase();

					if (searchText.includes(q)) {
						// Extract folder path and filename
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

	// SPA fallback - serve index.html for all other routes
	app.get("/{*path}", (_req: Request, res: Response) => {
		const indexPath = join(uiDistPath, "index.html");
		if (existsSync(indexPath)) {
			// Use root option for more reliable path resolution
			res.sendFile("index.html", { root: uiDistPath });
		} else {
			res.status(404).send("Not Found");
		}
	});

	// Start server
	return new Promise<{ close: () => void }>((resolve) => {
		httpServer.listen(port, () => {
			console.log(`✓ Server running at http://localhost:${port}`);

			if (open) {
				// Open browser (platform-specific)
				try {
					const url = `http://localhost:${port}`;
					if (isBun) {
						const openCommand =
							process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
						Bun.spawn([openCommand, url]);
					} else if (process.platform === "darwin") {
						spawn("open", [url], { stdio: "ignore" });
					} else if (process.platform === "win32") {
						spawn("cmd", ["/c", "start", "", url], { stdio: "ignore" });
					} else {
						spawn("xdg-open", [url], { stdio: "ignore" });
					}
				} catch (error) {
					console.error("Failed to open browser:", error);
				}
			}

			resolve({
				close: () => {
					wss.close();
					httpServer.close();
				},
			});
		});
	});
}

// Helper function to recursively find all .md files
async function findMarkdownFiles(dir: string, baseDir: string): Promise<string[]> {
	const files: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);

		if (entry.isDirectory()) {
			// Recursively search subdirectories
			const subFiles = await findMarkdownFiles(fullPath, baseDir);
			files.push(...subFiles);
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			// Return relative path from baseDir
			const relativePath = relative(baseDir, fullPath);
			files.push(relativePath);
		}
	}

	return files;
}
