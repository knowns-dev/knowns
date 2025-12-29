/**
 * Centralized error handling middleware
 */

import type { NextFunction, Request, Response } from "express";

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
	console.error("Server error:", err);
	res.status(500).json({ error: err.message });
}
