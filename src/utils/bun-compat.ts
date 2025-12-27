/**
 * Bun compatibility layer for Node.js
 * Provides Bun-like APIs that work in both Bun and Node.js
 */

import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";

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

// Re-export for convenience
export const BunCompat = {
	file,
	write,
	spawn: bunSpawn,
};

export default BunCompat;
