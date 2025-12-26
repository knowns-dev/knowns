/**
 * Local Server
 * Serves Web UI via `knowns browser`
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { FileStore } from "@storage/file-store";
import type { ServerWebSocket } from "bun";
import matter from "gray-matter";

interface ServerOptions {
	port: number;
	projectRoot: string;
	open: boolean;
}

interface WebSocketData {
	type: string;
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
	const clients = new Set<ServerWebSocket<WebSocketData>>();

	// Broadcast to all connected clients
	const broadcast = (data: object) => {
		const msg = JSON.stringify(data);
		for (const client of clients) {
			client.send(msg);
		}
	};

	// Find the UI files in the installed package
	const currentDir = import.meta.dir;

	// Try to find package root by checking parent directories
	let packageRoot = currentDir;

	// If we're in dist/ folder (bundled), go up 1 level to package root
	if (currentDir.endsWith("/dist")) {
		packageRoot = join(currentDir, "..");
	}
	// If we're in src/server (development), go up 2 levels to package root
	else if (currentDir.includes("/src/server")) {
		packageRoot = join(currentDir, "..", "..");
	}

	const uiDistPath = join(packageRoot, "dist", "ui");

	// Check if UI build exists
	if (!existsSync(join(uiDistPath, "index.html"))) {
		throw new Error(`UI build not found at ${uiDistPath}. Run 'bun run build:ui' first.`);
	}

	const server = Bun.serve({
		port,

		async fetch(req, server) {
			const url = new URL(req.url);

			// WebSocket upgrade
			if (url.pathname === "/ws") {
				const upgraded = server.upgrade(req, {
					data: { type: "client" },
				});
				if (upgraded) {
					return undefined;
				}
				return new Response("WebSocket upgrade failed", { status: 500 });
			}

			// API Routes
			if (url.pathname.startsWith("/api/")) {
				return handleAPI(req, url, store, broadcast);
			}

			// Serve static assets from Vite build (assets folder with hashed names)
			if (url.pathname.startsWith("/assets/")) {
				const filePath = join(uiDistPath, url.pathname);
				const file = Bun.file(filePath);
				if (await file.exists()) {
					const ext = url.pathname.split(".").pop();
					const contentType =
						ext === "js"
							? "application/javascript"
							: ext === "css"
								? "text/css"
								: ext === "svg"
									? "image/svg+xml"
									: ext === "png"
										? "image/png"
										: ext === "jpg" || ext === "jpeg"
											? "image/jpeg"
											: ext === "woff2"
												? "font/woff2"
												: ext === "woff"
													? "font/woff"
													: "application/octet-stream";
					return new Response(file, {
						headers: {
							"Content-Type": contentType,
							// Vite assets have content hash, can cache forever
							"Cache-Control": "public, max-age=31536000, immutable",
						},
					});
				}
			}

			// Serve index.html for root and SPA routes
			if (url.pathname === "/" || url.pathname === "/index.html" || !url.pathname.includes(".")) {
				const indexFile = Bun.file(join(uiDistPath, "index.html"));
				if (await indexFile.exists()) {
					return new Response(indexFile, {
						headers: {
							"Content-Type": "text/html",
							"Cache-Control": "no-cache, no-store, must-revalidate",
						},
					});
				}
			}

			return new Response("Not Found", { status: 404 });
		},

		websocket: {
			open(ws) {
				clients.add(ws);
			},
			close(ws) {
				clients.delete(ws);
			},
			message(_ws, _message) {
				// Handle client messages if needed
			},
		},
	});

	console.log(`✓ Server running at http://localhost:${port}`);

	if (open) {
		// Open browser (platform-specific)
		const openCommand = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";

		try {
			Bun.spawn([openCommand, `http://localhost:${port}`]);
		} catch (error) {
			console.error("Failed to open browser:", error);
		}
	}

	return server;
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

async function handleAPI(
	req: Request,
	url: URL,
	store: FileStore,
	broadcast: (data: object) => void,
): Promise<Response> {
	const headers = {
		"Content-Type": "application/json",
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
	};

	// Handle OPTIONS for CORS
	if (req.method === "OPTIONS") {
		return new Response(null, { headers });
	}

	try {
		// GET /api/tasks
		if (url.pathname === "/api/tasks" && req.method === "GET") {
			const tasks = await store.getAllTasks();
			return new Response(JSON.stringify(tasks), { headers });
		}

		// GET /api/tasks/:id/history - Get version history for a task
		const historyMatch = url.pathname.match(/^\/api\/tasks\/(.+)\/history$/);
		if (historyMatch && req.method === "GET") {
			const taskId = historyMatch[1];
			const history = await store.getTaskVersionHistory(taskId);
			return new Response(JSON.stringify({ versions: history }), { headers });
		}

		// GET /api/tasks/:id
		const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
		if (taskMatch && req.method === "GET") {
			const task = await store.getTask(taskMatch[1]);
			if (!task) {
				return new Response(JSON.stringify({ error: "Task not found" }), {
					status: 404,
					headers,
				});
			}
			return new Response(JSON.stringify(task), { headers });
		}

		// PUT /api/tasks/:id
		if (taskMatch && req.method === "PUT") {
			try {
				const updates = await req.json();
				const task = await store.updateTask(taskMatch[1], updates);

				// Broadcast update to all clients
				broadcast({ type: "tasks:updated", task });

				return new Response(JSON.stringify(task), { headers });
			} catch (error) {
				console.error("Error updating task:", error);
				return new Response(JSON.stringify({ error: String(error) }), {
					status: 500,
					headers,
				});
			}
		}

		// POST /api/tasks
		if (url.pathname === "/api/tasks" && req.method === "POST") {
			const data = await req.json();
			const task = await store.createTask(data);

			// Broadcast new task to all clients
			broadcast({ type: "tasks:updated", task });

			return new Response(JSON.stringify(task), {
				headers,
				status: 201,
			});
		}

		// POST /api/notify - CLI notifies server about task/doc changes
		if (url.pathname === "/api/notify" && req.method === "POST") {
			try {
				const { taskId, type, docPath } = await req.json();

				if (taskId) {
					// Reload task from disk and broadcast
					const task = await store.getTask(taskId);
					if (task) {
						broadcast({ type: "tasks:updated", task });
						return new Response(JSON.stringify({ success: true }), { headers });
					}
				} else if (type === "tasks:refresh") {
					// Broadcast refresh signal to reload all tasks
					broadcast({ type: "tasks:refresh" });
					return new Response(JSON.stringify({ success: true }), { headers });
				} else if (type === "docs:updated" && docPath) {
					// Broadcast doc update
					broadcast({ type: "docs:updated", docPath });
					return new Response(JSON.stringify({ success: true }), { headers });
				} else if (type === "docs:refresh") {
					// Broadcast docs refresh signal
					broadcast({ type: "docs:refresh" });
					return new Response(JSON.stringify({ success: true }), { headers });
				}

				return new Response(JSON.stringify({ success: false, error: "Invalid notify request" }), {
					status: 400,
					headers,
				});
			} catch (error) {
				console.error("[Server] Notify error:", error);
				return new Response(JSON.stringify({ error: String(error) }), {
					status: 500,
					headers,
				});
			}
		}

		// GET /api/docs
		if (url.pathname === "/api/docs" && req.method === "GET") {
			const docsDir = join(store.projectRoot, ".knowns", "docs");

			if (!existsSync(docsDir)) {
				return new Response(JSON.stringify({ docs: [] }), { headers });
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

			return new Response(JSON.stringify({ docs }), { headers });
		}

		// GET /api/docs/:path - Get single doc by path
		if (url.pathname.startsWith("/api/docs/") && req.method === "GET") {
			const docPath = decodeURIComponent(url.pathname.replace("/api/docs/", ""));
			const docsDir = join(store.projectRoot, ".knowns", "docs");
			const fullPath = join(docsDir, docPath);

			// Security: ensure path doesn't escape docs directory
			if (!fullPath.startsWith(docsDir)) {
				return new Response(JSON.stringify({ error: "Invalid path" }), {
					status: 400,
					headers,
				});
			}

			if (!existsSync(fullPath)) {
				return new Response(JSON.stringify({ error: "Document not found" }), {
					status: 404,
					headers,
				});
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

			return new Response(JSON.stringify(doc), { headers });
		}

		// PUT /api/docs/:path - Update existing doc
		if (url.pathname.startsWith("/api/docs/") && req.method === "PUT") {
			const docPath = decodeURIComponent(url.pathname.replace("/api/docs/", ""));
			const docsDir = join(store.projectRoot, ".knowns", "docs");
			const fullPath = join(docsDir, docPath);

			// Security: ensure path doesn't escape docs directory
			if (!fullPath.startsWith(docsDir)) {
				return new Response(JSON.stringify({ error: "Invalid path" }), {
					status: 400,
					headers,
				});
			}

			if (!existsSync(fullPath)) {
				return new Response(JSON.stringify({ error: "Document not found" }), {
					status: 404,
					headers,
				});
			}

			const data = await req.json();
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

			return new Response(JSON.stringify(updatedDoc), { headers });
		}

		// POST /api/docs
		if (url.pathname === "/api/docs" && req.method === "POST") {
			const docsDir = join(store.projectRoot, ".knowns", "docs");

			// Ensure docs directory exists
			if (!existsSync(docsDir)) {
				await mkdir(docsDir, { recursive: true });
			}

			const data = await req.json();
			const { title, description, tags, content, folder } = data;

			if (!title) {
				return new Response(JSON.stringify({ error: "Title is required" }), {
					status: 400,
					headers,
				});
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
				return new Response(JSON.stringify({ error: "Document with this title already exists in this folder" }), {
					status: 409,
					headers,
				});
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

			return new Response(
				JSON.stringify({
					success: true,
					filename,
					folder: folder || "",
					path: folder ? `${folder}/${filename}` : filename,
					metadata: frontmatter,
				}),
				{ status: 201, headers },
			);
		}

		// GET /api/config
		if (url.pathname === "/api/config" && req.method === "GET") {
			const configPath = join(store.projectRoot, ".knowns", "config.json");

			if (!existsSync(configPath)) {
				return new Response(
					JSON.stringify({
						config: {
							name: "Knowns",
							defaultPriority: "medium",
							defaultLabels: [],
							timeFormat: "24h",
							visibleColumns: ["todo", "in-progress", "done"],
						},
					}),
					{ headers },
				);
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

			return new Response(JSON.stringify({ config }), { headers });
		}

		// POST /api/config
		if (url.pathname === "/api/config" && req.method === "POST") {
			const config = await req.json();
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

			return new Response(JSON.stringify({ success: true }), { headers });
		}

		// GET /api/activities - Get recent activities across all tasks
		if (url.pathname === "/api/activities" && req.method === "GET") {
			const limit = Number.parseInt(url.searchParams.get("limit") || "50", 10);
			const type = url.searchParams.get("type"); // Filter by change type

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

			return new Response(JSON.stringify({ activities: limited }), { headers });
		}

		// GET /api/search?q=query
		if (url.pathname === "/api/search" && req.method === "GET") {
			const query = url.searchParams.get("q");
			if (!query) {
				return new Response(JSON.stringify({ tasks: [], docs: [] }), { headers });
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

			return new Response(JSON.stringify({ tasks: taskResults, docs: docResults }), {
				headers,
			});
		}

		return new Response(JSON.stringify({ error: "Not Found" }), {
			status: 404,
			headers,
		});
	} catch (error) {
		console.error("API Error:", error);
		return new Response(
			JSON.stringify({
				error: error instanceof Error ? error.message : "Internal Server Error",
			}),
			{ status: 500, headers },
		);
	}
}
