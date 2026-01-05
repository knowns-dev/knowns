/**
 * SSE (Server-Sent Events) Route
 * Provides real-time updates to connected clients
 */

import { type Request, type Response, Router } from "express";

// Track connected SSE clients
const clients = new Set<Response>();

/**
 * Broadcast event to all connected SSE clients
 */
export function broadcast(event: string, data: object): void {
	const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

	for (const client of clients) {
		try {
			client.write(message);
		} catch {
			// Client disconnected, will be cleaned up
			clients.delete(client);
		}
	}
}

/**
 * Get connected client count (for debugging/monitoring)
 */
export function getClientCount(): number {
	return clients.size;
}

/**
 * Create SSE routes
 */
export function createEventsRoute(): Router {
	const router = Router();

	// SSE endpoint
	router.get("/", (req: Request, res: Response) => {
		// Set SSE headers
		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering

		// Flush headers immediately
		res.flushHeaders();

		// Send initial connection message
		res.write(`event: connected\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);

		// Add client to set
		clients.add(res);

		// Handle client disconnect
		req.on("close", () => {
			clients.delete(res);
		});

		// Keep connection alive with heartbeat every 30 seconds
		const heartbeatInterval = setInterval(() => {
			try {
				res.write(`: heartbeat ${Date.now()}\n\n`);
			} catch {
				clearInterval(heartbeatInterval);
				clients.delete(res);
			}
		}, 30000);

		// Cleanup on close
		res.on("close", () => {
			clearInterval(heartbeatInterval);
			clients.delete(res);
		});
	});

	return router;
}
