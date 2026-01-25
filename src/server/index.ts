/**
 * Local Server
 * Serves Web UI via `knowns browser`
 * Uses Express + SSE (Server-Sent Events) for real-time updates
 */

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileStore } from "@storage/file-store";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { errorHandler } from "./middleware/error-handler";
import { createRoutes } from "./routes";
import { broadcast, createEventsRoute } from "./routes/events";

// Check if running in Bun
const isBun = typeof globalThis.Bun !== "undefined";

interface ServerOptions {
	port: number;
	projectRoot: string;
	open: boolean;
}

export async function startServer(options: ServerOptions) {
	const { port, projectRoot, open } = options;
	const store = new FileStore(projectRoot);

	// Broadcast wrapper that extracts event type from data
	const broadcastEvent = (data: { type: string; [key: string]: unknown }) => {
		const { type, ...payload } = data;
		broadcast(type, payload);
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

	// Serve static assets from Vite build (assets folder with hashed names)
	app.use(
		"/assets",
		express.static(join(uiDistPath, "assets"), {
			maxAge: "1y",
			immutable: true,
		}),
	);

	// Serve root-level static files (favicon, logo, etc.)
	app.use(
		express.static(uiDistPath, {
			maxAge: "1d",
			index: false, // Don't serve index.html automatically
		}),
	);

	// Mount SSE events endpoint
	app.use("/api/events", createEventsRoute());

	// Mount API routes
	app.use("/api", createRoutes({ store, broadcast: broadcastEvent }));

	// Error handling middleware
	app.use(errorHandler);

	// SPA fallback - serve index.html for all other routes
	app.get("/{*path}", (_req: Request, res: Response) => {
		const indexPath = join(uiDistPath, "index.html");
		if (existsSync(indexPath)) {
			res.sendFile("index.html", { root: uiDistPath });
		} else {
			res.status(404).send("Not Found");
		}
	});

	// Start server
	return new Promise<{ close: () => void }>((resolve, reject) => {
		const server = app.listen(port, () => {
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
					server.close();
				},
			});
		});

		server.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "EADDRINUSE") {
				console.error(`Error: Port ${port} is already in use`);
				console.error("Please stop the process using this port or choose a different port");
				reject(err);
			} else {
				reject(err);
			}
		});
	});
}
