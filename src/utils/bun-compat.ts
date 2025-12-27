/**
 * Bun compatibility layer for Node.js
 * Provides Bun-like APIs that work in both Bun and Node.js
 */

import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { extname, join } from "node:path";

// Check if running in Bun
const isBun = typeof globalThis.Bun !== "undefined";

/**
 * Bun.file() compatible wrapper
 */
export function file(path: string) {
	return {
		async text(): Promise<string> {
			if (isBun) {
				return globalThis.Bun.file(path).text();
			}
			return readFile(path, "utf-8");
		},
		async exists(): Promise<boolean> {
			if (isBun) {
				return globalThis.Bun.file(path).exists();
			}
			try {
				await stat(path);
				return true;
			} catch {
				return false;
			}
		},
		async arrayBuffer(): Promise<ArrayBuffer> {
			if (isBun) {
				return globalThis.Bun.file(path).arrayBuffer();
			}
			const buffer = await readFile(path);
			return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
		},
	};
}

/**
 * Bun.write() compatible wrapper
 */
export async function write(path: string, content: string | Buffer): Promise<void> {
	if (isBun) {
		await globalThis.Bun.write(path, content);
		return;
	}
	await writeFile(path, content, "utf-8");
}

/**
 * Bun.spawn() compatible wrapper
 */
export function bunSpawn(command: string[]) {
	if (isBun) {
		return globalThis.Bun.spawn(command);
	}
	const [cmd, ...args] = command;
	return spawn(cmd, args, { stdio: "inherit" });
}

// MIME types for static file serving
const mimeTypes: Record<string, string> = {
	".html": "text/html",
	".js": "application/javascript",
	".css": "text/css",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
};

/**
 * Bun.serve() compatible wrapper (simplified version for knowns use case)
 */
export function serve(options: {
	port: number;
	fetch: (request: Request) => Promise<Response> | Response;
}): { stop: () => void } {
	if (isBun) {
		return globalThis.Bun.serve(options);
	}

	// Node.js HTTP server implementation
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		try {
			// Convert Node.js request to Fetch API Request
			const url = new URL(req.url || "/", `http://localhost:${options.port}`);
			const headers = new Headers();
			for (const [key, value] of Object.entries(req.headers)) {
				if (value) {
					headers.set(key, Array.isArray(value) ? value.join(", ") : value);
				}
			}

			const request = new Request(url.toString(), {
				method: req.method,
				headers,
			});

			// Call the fetch handler
			const response = await options.fetch(request);

			// Convert Fetch API Response to Node.js response
			res.statusCode = response.status;
			response.headers.forEach((value, key) => {
				res.setHeader(key, value);
			});

			const body = await response.arrayBuffer();
			res.end(Buffer.from(body));
		} catch (error) {
			console.error("Server error:", error);
			res.statusCode = 500;
			res.end("Internal Server Error");
		}
	});

	server.listen(options.port);

	return {
		stop: () => {
			server.close();
		},
	};
}

// Re-export for convenience
export const BunCompat = {
	file,
	write,
	spawn: bunSpawn,
	serve,
};

export default BunCompat;
