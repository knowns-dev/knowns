/**
 * Local Server
 * Serves Web UI via `knowns browser`
 */

import { watch } from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Task } from "@models/task";
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

// Build version to bust cache
let buildVersion = Date.now();

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

	// Find the UI files in the installed package (not in user's project)
	// When bundled with Bun, all code is in dist/index.js
	// So import.meta.dir will be the dist/ folder
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

	const uiSourcePath = join(packageRoot, "src", "ui");
	const uiDistPath = join(packageRoot, "dist", "ui");

	// Check if we should build (development mode with source files)
	let shouldBuild = false;

	if (existsSync(join(uiDistPath, "main.js"))) {
		// Pre-built UI exists, no need to build
		shouldBuild = false;
	} else if (existsSync(join(uiSourcePath, "index.html"))) {
		// Source UI exists, need to build to dist/ui
		shouldBuild = true;
	} else {
		throw new Error(
			`UI files not found. Tried:\n  - ${uiDistPath} (${existsSync(uiDistPath) ? "exists but no main.js" : "not found"})\n  - ${uiSourcePath} (${existsSync(uiSourcePath) ? "exists but no index.html" : "not found"})\nPackage root: ${packageRoot}\nCurrent dir: ${currentDir}`,
		);
	}

	// Build function (only used in development mode)
	const buildUI = async () => {
		if (!shouldBuild) {
			// Skip build in production mode
			return true;
		}

		console.log("Building UI...");
		const startTime = Date.now();

		// Ensure dist/ui directory exists
		if (!existsSync(uiDistPath)) {
			await mkdir(uiDistPath, { recursive: true });
		}

		// Build the bundle
		const buildResult = await Bun.build({
			entrypoints: [join(uiSourcePath, "main.tsx")],
			outdir: uiDistPath,
			target: "browser",
			minify: false,
			sourcemap: "inline",
			define: {
				"process.env.NODE_ENV": JSON.stringify("development"),
			},
		});

		if (!buildResult.success) {
			console.error("Build errors:", buildResult.logs);
			return false;
		}

		// Also build CSS
		const cssResult = await Bun.build({
			entrypoints: [join(uiSourcePath, "index.css")],
			outdir: uiDistPath,
			target: "browser",
			minify: false,
		});

		if (!cssResult.success) {
			console.error("CSS build errors:", cssResult.logs);
		}

		buildVersion = Date.now();
		console.log(`UI built in ${Date.now() - startTime}ms`);
		return true;
	};

	// Initial build (only if in development mode)
	if (shouldBuild) {
		if (!(await buildUI())) {
			throw new Error("Failed to build UI");
		}
	}

	// Watch for file changes and rebuild (only in development mode)
	let watcher: ReturnType<typeof watch> | null = null;
	if (shouldBuild) {
		let rebuildTimeout: ReturnType<typeof setTimeout> | null = null;
		watcher = watch(uiSourcePath, { recursive: true }, async (_event, filename) => {
			if (!filename) return;
			// Ignore non-source files
			if (!filename.endsWith(".tsx") && !filename.endsWith(".ts") && !filename.endsWith(".css")) {
				return;
			}

			// Debounce rebuilds
			if (rebuildTimeout) {
				clearTimeout(rebuildTimeout);
			}

			rebuildTimeout = setTimeout(async () => {
				console.log(`File changed: ${filename}`);
				const success = await buildUI();
				if (success) {
					// Notify all clients to reload
					broadcast({ type: "reload" });
				}
			}, 100);
		});

		// Cleanup watcher on process exit
		process.on("SIGINT", () => {
			watcher?.close();
			process.exit(0);
		});
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

			// Serve built JS bundle (with cache busting)
			if (url.pathname === "/main.js" || url.pathname.startsWith("/main.js?")) {
				const file = Bun.file(join(uiDistPath, "main.js"));
				if (await file.exists()) {
					return new Response(file, {
						headers: {
							"Content-Type": "application/javascript",
							"Cache-Control": "no-cache, no-store, must-revalidate",
						},
					});
				}
			}

			// Serve built CSS (with cache busting)
			if (url.pathname === "/index.css" || url.pathname.startsWith("/index.css?")) {
				const file = Bun.file(join(uiDistPath, "index.css"));
				if (await file.exists()) {
					return new Response(file, {
						headers: {
							"Content-Type": "text/css",
							"Cache-Control": "no-cache, no-store, must-revalidate",
						},
					});
				}
			}

			// Serve index.html for root (with live reload script)
			if (url.pathname === "/" || url.pathname === "/index.html") {
				const html = `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>Knowns - Task Management</title>
		<link rel="stylesheet" href="/index.css?v=${buildVersion}" />
	</head>
	<body>
		<div id="root"></div>
		<script type="module" src="/main.js?v=${buildVersion}"></script>
		<script>
			// Live reload via WebSocket
			(function() {
				let ws;
				let reconnectInterval;

				function connect() {
					ws = new WebSocket('ws://' + location.host + '/ws');

					ws.onopen = function() {
						console.log('[LiveReload] Connected');
						if (reconnectInterval) {
							clearInterval(reconnectInterval);
							reconnectInterval = null;
						}
					};

					ws.onmessage = function(event) {
						const data = JSON.parse(event.data);
						if (data.type === 'reload') {
							console.log('[LiveReload] Reloading...');
							location.reload();
						}
					};

					ws.onclose = function() {
						console.log('[LiveReload] Disconnected, reconnecting...');
						if (!reconnectInterval) {
							reconnectInterval = setInterval(connect, 1000);
						}
					};

					ws.onerror = function() {
						ws.close();
					};
				}

				connect();
			})();
		</script>
	</body>
</html>`;
				return new Response(html, {
					headers: {
						"Content-Type": "text/html",
						"Cache-Control": "no-cache, no-store, must-revalidate",
					},
				});
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

	console.log(`Server running at http://localhost:${port}`);
	console.log(`Open in browser: http://localhost:${port}`);
	if (shouldBuild) {
		console.log(`Live reload enabled - watching ${uiSourcePath}`);
	} else {
		console.log(`Serving pre-built UI from ${uiDistPath}`);
	}

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

		// GET /api/tasks/:id
		const taskMatch = url.pathname.match(/^\/api\/tasks\/(.+)$/);
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
			const updates = await req.json();
			const task = await store.updateTask(taskMatch[1], updates);

			// Broadcast update to all clients
			broadcast({ type: "tasks:updated", task });

			return new Response(JSON.stringify(task), { headers });
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
