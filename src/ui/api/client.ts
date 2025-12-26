import type { Task, TimeEntry } from "../../models/task";

const API_BASE = "";

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
			throw new Error(`Failed to update task ${id}`);
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
};

interface WebSocketMessage {
	type: string;
	task?: Task;
	tasks?: Task[];
}

export const { createTask, updateTask, getTasks, getTask } = api;

// WebSocket connection
export function connectWebSocket(onMessage: (data: WebSocketMessage) => void): WebSocket | null {
	try {
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

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
