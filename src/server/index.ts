/**
 * Local Server
 * Serves Web UI via `knowns browser`
 * Uses Express + ws for Node.js compatibility
 */

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileStore } from "@storage/file-store";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { type WebSocket, WebSocketServer } from "ws";
import { errorHandler } from "./middleware/error-handler";
import { createRoutes } from "./routes";

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

	// Mount API routes
	app.use("/api", createRoutes({ store, broadcast }));

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
