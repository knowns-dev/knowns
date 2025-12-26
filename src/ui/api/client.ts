import type { Task, TimeEntry } from "../../models/task";
import type { TaskChange, TaskVersion } from "../../models/version";

// Use env vars from Vite, fallback to relative paths for production
const API_BASE = import.meta.env.API_URL || "";
const WS_BASE = import.meta.env.WS_URL || "";

interface TaskDTO {
	id: string;
	title: string;
	description?: string;
	status: string;
	priority: string;
	assignee?: string;
	labels: string[];
	parent?: string;
	subtasks: string[];
	createdAt: string;
	updatedAt: string;
	acceptanceCriteria: Array<{ text: string; completed: boolean }>;
	timeSpent: number;
	timeEntries: Array<{
		id: string;
		startedAt: string;
		endedAt?: string;
		duration: number;
		note?: string;
	}>;
	implementationPlan?: string;
	implementationNotes?: string;
}

interface TaskVersionDTO {
	id: string;
	taskId: string;
	version: number;
	timestamp: string;
	author?: string;
	changes: TaskChange[];
	snapshot: Partial<TaskDTO>;
}

interface ActivityDTO {
	taskId: string;
	taskTitle: string;
	version: number;
	timestamp: string;
	author?: string;
	changes: TaskChange[];
}

export interface Activity {
	taskId: string;
	taskTitle: string;
	version: number;
	timestamp: Date;
	author?: string;
	changes: TaskChange[];
}

function parseVersionDTO(dto: TaskVersionDTO): TaskVersion {
	return {
		...dto,
		timestamp: new Date(dto.timestamp),
	};
}

function parseActivityDTO(dto: ActivityDTO): Activity {
	return {
		...dto,
		timestamp: new Date(dto.timestamp),
	};
}

function parseTaskDTO(dto: TaskDTO): Task {
	return {
		...dto,
		status: dto.status as Task["status"],
		priority: dto.priority as Task["priority"],
		createdAt: new Date(dto.createdAt),
		updatedAt: new Date(dto.updatedAt),
		timeEntries: dto.timeEntries.map((entry) => ({
			...entry,
			startedAt: new Date(entry.startedAt),
			endedAt: entry.endedAt ? new Date(entry.endedAt) : undefined,
		})),
	};
}

export const api = {
	async getTasks(): Promise<Task[]> {
		const res = await fetch(`${API_BASE}/api/tasks`);
		if (!res.ok) {
			throw new Error("Failed to fetch tasks");
		}
		const data = (await res.json()) as TaskDTO[];
		return data.map(parseTaskDTO);
	},

	async getTask(id: string): Promise<Task> {
		const res = await fetch(`${API_BASE}/api/tasks/${id}`);
		if (!res.ok) {
			throw new Error(`Failed to fetch task ${id}`);
		}
		const dto = (await res.json()) as TaskDTO;
		return parseTaskDTO(dto);
	},

	async updateTask(id: string, updates: Partial<Task>): Promise<Task> {
		const res = await fetch(`${API_BASE}/api/tasks/${id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(updates),
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Failed to update task ${id}: ${text}`);
		}
		const dto = (await res.json()) as TaskDTO;
		return parseTaskDTO(dto);
	},

	async createTask(data: Partial<Task>): Promise<Task> {
		const res = await fetch(`${API_BASE}/api/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!res.ok) {
			throw new Error("Failed to create task");
		}
		const dto = (await res.json()) as TaskDTO;
		return parseTaskDTO(dto);
	},

	async getTaskHistory(id: string): Promise<TaskVersion[]> {
		const res = await fetch(`${API_BASE}/api/tasks/${id}/history`);
		if (!res.ok) {
			throw new Error(`Failed to fetch history for task ${id}`);
		}
		const data = (await res.json()) as { versions: TaskVersionDTO[] };
		return data.versions.map(parseVersionDTO);
	},

	async getActivities(options?: { limit?: number; type?: string }): Promise<Activity[]> {
		const params = new URLSearchParams();
		if (options?.limit) params.set("limit", options.limit.toString());
		if (options?.type) params.set("type", options.type);

		const res = await fetch(`${API_BASE}/api/activities?${params.toString()}`);
		if (!res.ok) {
			throw new Error("Failed to fetch activities");
		}
		const data = (await res.json()) as { activities: ActivityDTO[] };
		return data.activities.map(parseActivityDTO);
	},
};

interface WebSocketMessage {
	type: string;
	task?: Task;
	tasks?: Task[];
}

export const { createTask, updateTask, getTasks, getTask, getTaskHistory, getActivities } = api;

// Config API
export async function getConfig(): Promise<Record<string, unknown>> {
	const res = await fetch(`${API_BASE}/api/config`);
	if (!res.ok) {
		throw new Error("Failed to fetch config");
	}
	const data = await res.json();
	return data.config || {};
}

export async function saveConfig(config: Record<string, unknown>): Promise<void> {
	const res = await fetch(`${API_BASE}/api/config`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(config),
	});
	if (!res.ok) {
		throw new Error("Failed to save config");
	}
}

// Docs API
export interface Doc {
	path: string;
	title: string;
	description?: string;
	tags?: string[];
	content?: string;
}

export async function getDocs(): Promise<Doc[]> {
	const res = await fetch(`${API_BASE}/api/docs`);
	if (!res.ok) {
		throw new Error("Failed to fetch docs");
	}
	const data = await res.json();
	return data.docs || [];
}

export async function getDoc(path: string): Promise<Doc | null> {
	const res = await fetch(`${API_BASE}/api/docs/${encodeURIComponent(path)}`);
	if (!res.ok) {
		if (res.status === 404) return null;
		throw new Error(`Failed to fetch doc ${path}`);
	}
	return res.json();
}

export async function createDoc(data: Record<string, unknown>): Promise<unknown> {
	const res = await fetch(`${API_BASE}/api/docs`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(data),
	});
	if (!res.ok) {
		throw new Error("Failed to create doc");
	}
	return res.json();
}

export async function updateDoc(
	path: string,
	data: { content?: string; title?: string; description?: string; tags?: string[] },
): Promise<Doc> {
	const res = await fetch(`${API_BASE}/api/docs/${encodeURIComponent(path)}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(data),
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({ error: "Failed to update doc" }));
		throw new Error(error.error || "Failed to update doc");
	}
	return res.json();
}

// Search API
export async function search(query: string): Promise<{ tasks: Task[]; docs: unknown[] }> {
	const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(query)}`);
	if (!res.ok) {
		throw new Error("Failed to search");
	}
	const data = await res.json();
	return {
		tasks: (data.tasks || []).map(parseTaskDTO),
		docs: data.docs || [],
	};
}

// WebSocket connection
export function connectWebSocket(onMessage: (data: WebSocketMessage) => void): WebSocket | null {
	try {
		// Use WS_BASE from env, fallback to current host
		const wsUrl = WS_BASE
			? `${WS_BASE}/ws`
			: `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;
		const ws = new WebSocket(wsUrl);

		ws.onmessage = (e) => {
			try {
				const rawData = JSON.parse(e.data);
				// Parse task DTO to Task if present
				const data: WebSocketMessage = {
					...rawData,
					task: rawData.task ? parseTaskDTO(rawData.task) : undefined,
				};
				onMessage(data);
			} catch (error) {
				console.error("Failed to parse WebSocket message:", error);
			}
		};

		ws.onerror = (error) => {
			console.error("WebSocket error:", error);
		};

		ws.onclose = () => {
			console.log("WebSocket connection closed");
		};

		return ws;
	} catch (error) {
		console.error("Failed to create WebSocket connection:", error);
		return null;
	}
}
