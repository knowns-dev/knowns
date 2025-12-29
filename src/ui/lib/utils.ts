import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * Path utilities for cross-platform compatibility
 */

/**
 * Normalize path to use forward slashes (web-friendly format)
 * Converts Windows backslashes to forward slashes
 */
export function normalizePath(path: string): string {
	if (!path) return path;
	return path.replace(/\\/g, "/");
}

/**
 * Convert path to display format
 * On web, we always use forward slashes for URLs and display
 */
export function toDisplayPath(path: string): string {
	return normalizePath(path);
}

/**
 * Detect if running on Windows (server-side hint from path)
 * Returns true if path contains backslashes
 */
export function isWindowsPath(path: string): boolean {
	return path.includes("\\");
}

/**
 * Normalize path for API requests
 * Always sends forward slashes to server, server handles OS-specific conversion
 */
export function normalizePathForAPI(path: string): string {
	return normalizePath(path);
}
