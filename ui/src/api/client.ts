import type { Task, TimeEntry } from "@/ui/models/task";
import type { TaskChange, TaskVersion } from "@/ui/models/version";

// Use env vars from Vite, fallback to relative paths for production
const API_BASE = import.meta.env.API_URL || "";

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
	spec?: string;
	fulfills?: string[]; // Spec ACs this task fulfills (e.g., ["AC-1", "AC-2"])
	order?: number;
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
		subtasks: dto.subtasks || [],
		labels: dto.labels || [],
		acceptanceCriteria: dto.acceptanceCriteria || [],
		createdAt: new Date(dto.createdAt),
		updatedAt: new Date(dto.updatedAt),
		timeEntries: (dto.timeEntries || []).map((entry) => ({
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
		const data = (await res.json()) as TaskVersionDTO[] | { versions: TaskVersionDTO[] };
		const versions = Array.isArray(data) ? data : data.versions || [];
		return versions.map(parseVersionDTO);
	},

	async archiveTask(id: string): Promise<{ success: boolean; task: Task }> {
		const res = await fetch(`${API_BASE}/api/tasks/${id}/archive`, {
			method: "POST",
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Failed to archive task ${id}: ${text}`);
		}
		const data = await res.json();
		return { success: data.success, task: parseTaskDTO(data.task) };
	},

	async unarchiveTask(id: string): Promise<{ success: boolean; task: Task }> {
		const res = await fetch(`${API_BASE}/api/tasks/${id}/unarchive`, {
			method: "POST",
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Failed to unarchive task ${id}: ${text}`);
		}
		const data = await res.json();
		return { success: data.success, task: parseTaskDTO(data.task) };
	},

	async batchArchiveTasks(olderThanMs: number): Promise<{ success: boolean; count: number; tasks: Task[] }> {
		const res = await fetch(`${API_BASE}/api/tasks/batch-archive`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ olderThanMs }),
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Failed to batch archive tasks: ${text}`);
		}
		const data = await res.json();
		return {
			success: data.success,
			count: data.count,
			tasks: data.tasks.map(parseTaskDTO),
		};
	},

	async reorderTasks(orders: Array<{ id: string; order: number }>): Promise<void> {
		const res = await fetch(`${API_BASE}/api/tasks/reorder`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ orders }),
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Failed to reorder tasks: ${text}`);
		}
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

export interface ActiveTimer {
	taskId: string;
	taskTitle: string;
	startedAt: string;
	pausedAt: string | null;
	totalPausedMs: number;
}

export const {
	createTask,
	updateTask,
	getTasks,
	getTask,
	getTaskHistory,
	getActivities,
	archiveTask,
	unarchiveTask,
	batchArchiveTasks,
	reorderTasks,
} = api;

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

// User Preferences API (user-level, cross-project)
export async function getUserPreferences(): Promise<Record<string, unknown>> {
	const res = await fetch(`${API_BASE}/api/user-preferences`);
	if (!res.ok) {
		throw new Error("Failed to fetch user preferences");
	}
	return res.json();
}

export async function saveUserPreferences(prefs: Record<string, unknown>): Promise<void> {
	const res = await fetch(`${API_BASE}/api/user-preferences`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(prefs),
	});
	if (!res.ok) {
		throw new Error("Failed to save user preferences");
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
	// Encode each path segment separately to preserve '/' for the wildcard route.
	const encodedPath = path.split("/").map(encodeURIComponent).join("/");
	const res = await fetch(`${API_BASE}/api/docs/${encodedPath}`);
	if (!res.ok) {
		if (res.status === 404) return null;
		throw new Error(`Failed to fetch doc ${path}`);
	}
	const data = await res.json();
	// Server returns nested {metadata: {title, ...}} — flatten for client Doc type.
	if (data.metadata && !data.title) {
		data.title = data.metadata.title;
		data.description = data.metadata.description;
		data.tags = data.metadata.tags;
	}
	return data;
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
	const encodedPath = path.split("/").map(encodeURIComponent).join("/");
	const res = await fetch(`${API_BASE}/api/docs/${encodedPath}`, {
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

function normalizeSpecLink(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/^\//, "").replace(/\.md$/, "");
	const specsIndex = normalized.indexOf("specs/");
	if (specsIndex >= 0) {
		return normalized.slice(specsIndex);
	}
	return normalized;
}

function taskMentionsSpec(task: Task, normalizedSpec: string): boolean {
	const references = [task.spec, task.description, task.implementationPlan, task.implementationNotes]
		.filter(Boolean)
		.map((value) => String(value));

	for (const ac of task.acceptanceCriteria || []) {
		references.push(ac.text);
	}

	for (const ref of references) {
		const directMatches = ref.match(/@doc\/([A-Za-z0-9_./-]+)/g) || [];
		for (const match of directMatches) {
			const path = normalizeSpecLink(match.slice(5));
			if (path === normalizedSpec) {
				return true;
			}
		}

		if (normalizeSpecLink(ref) === normalizedSpec) {
			return true;
		}
	}

	return false;
}

// Get tasks linked to a spec
export async function getTasksBySpec(specPath: string): Promise<Task[]> {
	const tasks = await api.getTasks();
	const normalizedSpec = normalizeSpecLink(specPath);
	return tasks.filter((task) => taskMentionsSpec(task, normalizedSpec));
}

// SDD (Spec-Driven Development) Stats
export interface SDDStats {
	specs: { total: number; approved: number; draft: number; implemented: number };
	tasks: { total: number; done: number; inProgress: number; todo: number; withSpec: number; withoutSpec: number };
	coverage: { linked: number; total: number; percent: number };
	acCompletion: Record<string, { total: number; completed: number; percent: number }>;
}

export interface SDDWarning {
	type: "task-no-spec" | "spec-broken-link" | "spec-ac-incomplete";
	entity: string;
	message: string;
}

export interface SDDResult {
	stats: SDDStats;
	warnings: SDDWarning[];
	passed: string[];
}

export async function getSDDStats(): Promise<SDDResult> {
	const res = await fetch(`${API_BASE}/api/validate/sdd`);
	if (!res.ok) throw new Error("Failed to fetch SDD stats");
	return res.json();
}


export interface RuntimeJob {
	id: string;
	key: string;
	kind: string;
	target?: string;
	requestedAt: string;
	runAfter: string;
	startedAt?: string;
	attempts?: number;
	lastError?: string;
	phase?: string;
	processed?: number;
	total?: number;
}

export interface JobDetails {
	phase?: string;
	processed?: number;
	total?: number;
	stats?: Record<string, number>;
}

export interface RuntimeJobResult {
	jobId: string;
	key: string;
	kind: string;
	target?: string;
	success: boolean;
	error?: string;
	completedAt: string;
	requestedAt: string;
	startedAt: string;
	attemptCount: number;
	details?: JobDetails;
}

export interface RuntimeClient {
	clientKind: string;
	projectRoot: string;
	pid: number;
	updatedAt: string;
}

export interface RuntimeProjectSnapshot {
	root: string;
	running: RuntimeJob[];
	queued: RuntimeJob[];
	recent: RuntimeJobResult[];
}

export interface RuntimeStatusResponse {
	status: {
		running: boolean;
		pid?: number;
		version?: string;
		clients: RuntimeClient[];
		projects: Array<{ projectRoot: string; queuedJobs: number; runningJobs: number }>;
	};
	projects: RuntimeProjectSnapshot[];
}

export async function getRuntimePs(): Promise<RuntimeStatusResponse> {
	const res = await fetch(`${API_BASE}/api/runtime/ps`);
	if (!res.ok) {
		throw new Error("Failed to fetch runtime status");
	}
	return res.json();
}

export interface RuntimeService {
	name: string;
	type: string;
	status: "running" | "stopped" | "disabled" | "error";
	pid?: number;
	port?: number;
	uptime?: string;
	enabledInConfig: boolean;
	details?: Record<string, unknown>;
}

export interface RuntimeServicesResponse {
	services: RuntimeService[];
}

export async function getRuntimeServices(): Promise<RuntimeServicesResponse> {
	const res = await fetch(`${API_BASE}/api/runtime/services`);
	if (!res.ok) {
		throw new Error("Failed to fetch runtime services");
	}
	return res.json();
}

// Import API
export interface Import {
	name: string;
	source: string;
	type: "git" | "npm" | "local" | "registry";
	ref?: string;
	link: boolean;
	autoSync: boolean;
	lastSync?: string;
	fileCount: number;
	importedAt?: string;
}

export interface ImportDetail extends Import {
	include?: string[];
	exclude?: string[];
	commit?: string;
	version?: string;
	files: string[];
}

export interface ImportChange {
	path: string;
	action: "add" | "update" | "skip";
	skipReason?: string;
}

export interface ImportResult {
	success: boolean;
	dryRun: boolean;
	import: {
		name: string;
		source: string;
		type: string;
	};
	changes: ImportChange[];
	summary: {
		added: number;
		updated: number;
		skipped: number;
		modifiedLocally?: number;
	};
	warnings?: string[];
	error?: string;
}

export const importApi = {
	async list(): Promise<{ imports: Import[]; count: number }> {
		const res = await fetch(`${API_BASE}/api/imports`);
		if (!res.ok) {
			throw new Error("Failed to fetch imports");
		}
		return res.json();
	},

	async get(name: string): Promise<{ import: ImportDetail }> {
		const res = await fetch(`${API_BASE}/api/imports/${encodeURIComponent(name)}`);
		if (!res.ok) {
			if (res.status === 404) {
				throw new Error(`Import not found: ${name}`);
			}
			throw new Error(`Failed to fetch import ${name}`);
		}
		return res.json();
	},

	async add(data: {
		source: string;
		name?: string;
		type?: string;
		ref?: string;
		include?: string[];
		exclude?: string[];
		link?: boolean;
		force?: boolean;
		dryRun?: boolean;
	}): Promise<ImportResult> {
		const res = await fetch(`${API_BASE}/api/imports`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!res.ok) {
			const error = await res.json();
			throw new Error(error.error || "Failed to add import");
		}
		return res.json();
	},

	async sync(name: string, options?: { force?: boolean; dryRun?: boolean }): Promise<ImportResult> {
		const res = await fetch(`${API_BASE}/api/imports/${encodeURIComponent(name)}/sync`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(options || {}),
		});
		if (!res.ok) {
			const error = await res.json();
			throw new Error(error.error || `Failed to sync import ${name}`);
		}
		return res.json();
	},

	async syncAll(options?: { force?: boolean; dryRun?: boolean }): Promise<{
		success: boolean;
		dryRun: boolean;
		results: Array<{
			name: string;
			source: string;
			type: string;
			success: boolean;
			error?: string;
			summary?: { added: number; updated: number; skipped: number };
		}>;
		summary: { total: number; successful: number; failed: number };
	}> {
		const res = await fetch(`${API_BASE}/api/imports/sync-all`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(options || {}),
		});
		if (!res.ok) {
			const error = await res.json();
			throw new Error(error.error || "Failed to sync imports");
		}
		return res.json();
	},

	async remove(name: string, deleteFiles = false): Promise<{ success: boolean; filesDeleted: boolean }> {
		const res = await fetch(`${API_BASE}/api/imports/${encodeURIComponent(name)}?delete=${deleteFiles}`, {
			method: "DELETE",
		});
		if (!res.ok) {
			const error = await res.json();
			throw new Error(error.error || `Failed to remove import ${name}`);
		}
		return res.json();
	},
};

// Time Tracking API - Multi-timer support
export const timeApi = {
	async getStatus(): Promise<{ active: ActiveTimer[] }> {
		const res = await fetch(`${API_BASE}/api/time/status`);
		if (!res.ok) {
			throw new Error("Failed to fetch time status");
		}
		return res.json();
	},

	async start(taskId: string): Promise<{ success: boolean; active: ActiveTimer[]; timer: ActiveTimer }> {
		const res = await fetch(`${API_BASE}/api/time/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ taskId }),
		});
		if (!res.ok) {
			const data = await res.json();
			throw new Error(data.error || "Failed to start timer");
		}
		return res.json();
	},

	async stop(
		taskId?: string,
		all?: boolean,
	): Promise<{
		success: boolean;
		stopped: Array<{ taskId: string; duration: number }>;
		active: ActiveTimer[];
	}> {
		const res = await fetch(`${API_BASE}/api/time/stop`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ taskId, all }),
		});
		if (!res.ok) {
			const data = await res.json();
			throw new Error(data.error || "Failed to stop timer");
		}
		return res.json();
	},

	async pause(
		taskId?: string,
		all?: boolean,
	): Promise<{
		success: boolean;
		paused: string[];
		active: ActiveTimer[];
	}> {
		const res = await fetch(`${API_BASE}/api/time/pause`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ taskId, all }),
		});
		if (!res.ok) {
			const data = await res.json();
			throw new Error(data.error || "Failed to pause timer");
		}
		return res.json();
	},

	async resume(
		taskId?: string,
		all?: boolean,
	): Promise<{
		success: boolean;
		resumed: string[];
		active: ActiveTimer[];
	}> {
		const res = await fetch(`${API_BASE}/api/time/resume`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ taskId, all }),
		});
		if (!res.ok) {
			const data = await res.json();
			throw new Error(data.error || "Failed to resume timer");
		}
		return res.json();
	},
};

// Chat API
import type { ChatSession, AgentInfo, AgentModelDef } from "@/ui/models/chat";

export const chatApi = {
	async getSessions(): Promise<ChatSession[]> {
		const res = await fetch(`${API_BASE}/api/chats`);
		if (!res.ok) throw new Error("Failed to fetch chat sessions");
		return res.json();
	},

	async getSession(id: string): Promise<ChatSession> {
		const res = await fetch(`${API_BASE}/api/chats/${encodeURIComponent(id)}`);
		if (!res.ok) throw new Error(`Failed to fetch chat session ${id}`);
		return res.json();
	},

	async createSession(data: {
		agentType: string;
		model?: string;
		title?: string;
		taskId?: string;
	}): Promise<ChatSession> {
		const res = await fetch(`${API_BASE}/api/chats`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({ error: "Failed to create session" }));
			throw new Error(err.error || "Failed to create session");
		}
		return res.json();
	},

	async updateSession(id: string, data: { title?: string; model?: string }): Promise<ChatSession> {
		const res = await fetch(`${API_BASE}/api/chats/${encodeURIComponent(id)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!res.ok) throw new Error("Failed to update session");
		return res.json();
	},

	async deleteSession(id: string): Promise<void> {
		const res = await fetch(`${API_BASE}/api/chats/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
		if (!res.ok) throw new Error("Failed to delete session");
	},

	async sendMessage(id: string, content: string): Promise<{ status: string; message: unknown }> {
		const res = await fetch(`${API_BASE}/api/chats/${encodeURIComponent(id)}/send`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content }),
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({ error: "Failed to send message" }));
			throw new Error(err.error || "Failed to send message");
		}
		return res.json();
	},

	async stopChat(id: string): Promise<void> {
		const res = await fetch(`${API_BASE}/api/chats/${encodeURIComponent(id)}/stop`, {
			method: "POST",
		});
		if (!res.ok) throw new Error("Failed to stop chat");
	},

	async getQueue(id: string): Promise<{ queueSize: number; maxSize: number; messages: string[] }> {
		const res = await fetch(`${API_BASE}/api/chats/${encodeURIComponent(id)}/queue`);
		if (!res.ok) throw new Error("Failed to get queue");
		return res.json();
	},

	async processQueue(id: string): Promise<{ hasMore: boolean; message: string; queueSize: number }> {
		const res = await fetch(`${API_BASE}/api/chats/${encodeURIComponent(id)}/process-queue`, {
			method: "POST",
		});
		if (!res.ok) throw new Error("Failed to process queue");
		return res.json();
	},

	async getAgents(): Promise<{ agents: AgentInfo[]; models: AgentModelDef[] }> {
		const res = await fetch(`${API_BASE}/api/chats/agents`);
		if (!res.ok) throw new Error("Failed to fetch agents");
		return res.json();
	},
};

const OPENCODE_BASE = `${API_BASE}/api/opencode`;

function getOpenCodeHeaders(directory?: string | null, contentType?: string): HeadersInit | undefined {
	const headers: Record<string, string> = {};
	if (contentType) headers["Content-Type"] = contentType;
	if (directory) headers["x-opencode-directory"] = directory;
	return Object.keys(headers).length > 0 ? headers : undefined;
}

export interface OpenCodeStatus {
	configured: boolean;
	mode?: "managed" | "external";
	state?: "ready" | "degraded" | "unavailable";
	available: boolean;
	ready?: boolean;
	host: string;
	port: number;
	cliAvailable?: boolean;
	cliInstalled?: boolean;
	compatible?: boolean;
	version?: string;
	minVersion?: string;
	restartCount?: number;
	lastError?: string;
	lastHealthyAt?: string;
	readiness?: {
		healthy: boolean;
		configOk: boolean;
		agentOk: boolean;
		ready: boolean;
		version?: string;
		error?: string;
	};
	error?: string;
}

export interface OpenCodeSession {
	id: string;
	title: string;
	directory: string;
	slug: string;
	parentID?: string | null;
	permission?: Array<{
		permission: string;
		pattern: string;
		action: string;
	}>;
	time: {
		created: number;
		updated: number;
	};
}

export interface OpenCodeMessage {
	info: {
		id: string;
		role: string;
		time: { created: number; completed?: number };
		modelID?: string;
		providerID?: string;
		[key: string]: any;
	};
	parts: Array<{
		type: string;
		text?: string;
		reasoning?: string;
		[key: string]: any;
	}>;
}

export interface OpenCodeProviderResponse {
	all: Array<{
		id: string;
		name: string;
		env?: string[];
		models?: Record<
			string,
			{
				id: string;
				name: string;
				limit?: {
					context?: number;
					input?: number;
					output?: number;
				};
				capabilities?: {
					attachment?: boolean;
					input?: {
						text?: boolean;
						audio?: boolean;
						image?: boolean;
						video?: boolean;
						pdf?: boolean;
					};
					output?: {
						text?: boolean;
						audio?: boolean;
						image?: boolean;
						video?: boolean;
						pdf?: boolean;
					};
				};
				variants?: Record<string, Record<string, unknown>>;
			}
		>;
	}>;
	default?: Record<string, string>;
	connected?: string[];
}

export interface ProviderAuthMethod {
	type: "oauth" | "api";
	label: string;
}

export interface ProviderAuthAuthorization {
	url: string;
	method: "auto" | "code";
	instructions: string;
}

export type OpenCodeAuth =
	| { type: "api"; key: string }
	| { type: "oauth"; refresh: string; access: string; expires: number; enterpriseUrl?: string }
	| { type: "wellknown"; key: string; token: string };

export interface OpenCodeModelSelection {
	providerID: string;
	modelID: string;
}

export interface OpenCodeTodo {
	id: string;
	content: string;
	status: "pending" | "in_progress" | "completed" | "cancelled" | string;
	priority: "low" | "medium" | "high" | string;
}

export interface OpenCodePendingQuestion {
	id: string; // que_... ID used for reply/reject
	sessionID: string;
	questions: Array<{
		header?: string;
		question: string;
		multiple?: boolean;
		options: Array<{ label: string; description?: string }>;
	}>;
	tool: {
		messageID: string;
		callID: string;
	};
}

export interface OpenCodePendingPermission {
	id: string;
	sessionID: string;
	permission: string;
	patterns: string[];
	metadata: {
		filepath: string;
		parentDir: string;
	};
	always: string[];
	tool: {
		messageID: string;
		callID: string;
	};
}

export interface OpenCodePermissionResponse {
	response: "once" | "always" | "reject";
}

export interface OpenCodeQuestionReplyPayload {
	answers: string[][];
}

export interface OpenCodeAsyncPromptResponse {
	sessionID?: string;
}

export interface OpenCodeCommandDefinition {
	name: string;
	description?: string;
	source?: string;
	template?: string;
	hints?: string[];
	subtask?: boolean;
}

export interface OpenCodeRunCommandRequest {
	command: string;
	arguments?: string;
	agent?: string;
	model?: string;
	parts?: OpenCodePromptPart[];
	directory?: string | null;
}

export interface OpenCodeRunCommandResult {
	handled: boolean;
	data?: unknown;
}

export interface OpenCodeSummarizeSessionRequest {
	providerID: string;
	modelID: string;
}

export type OpenCodePromptPart =
	| { type: "text"; text: string; id?: string }
	| { type: "file"; mime: string; url: string; filename: string; id?: string };

function buildOpenCodePromptParts(contentOrParts: string | OpenCodePromptPart[]): OpenCodePromptPart[] {
	return typeof contentOrParts === "string" ? [{ type: "text", text: contentOrParts }] : contentOrParts;
}

const OPENCODE_COMMAND_HANDLED_SENTINEL = "__QUOTA_COMMAND_HANDLED__";

async function readOpenCodeResponsePayload(res: Response): Promise<{ message?: string; data?: unknown }> {
	const raw = await res.text();
	if (!raw) return {};

	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const nestedData = parsed.data && typeof parsed.data === "object" ? (parsed.data as Record<string, unknown>) : undefined;
		const messageCandidates = [nestedData?.message, parsed.error, parsed.message, raw];
		const message = messageCandidates.find((value): value is string => typeof value === "string" && value.trim().length > 0);
		return { message, data: parsed };
	} catch {
		return { message: raw };
	}
}

export const opencodeApi = {
	async getStatus(): Promise<OpenCodeStatus> {
		const res = await fetch(`${OPENCODE_BASE}/status`);
		if (!res.ok) throw new Error("Failed to fetch OpenCode status");
		return res.json();
	},

	async listSessions(): Promise<OpenCodeSession[]> {
		const res = await fetch(`${OPENCODE_BASE}/session`);
		if (!res.ok) throw new Error("Failed to fetch sessions");
		return res.json();
	},

	async getSession(id: string): Promise<OpenCodeSession> {
		const res = await fetch(`${OPENCODE_BASE}/session/${encodeURIComponent(id)}`);
		if (!res.ok) throw new Error(`Failed to fetch session ${id}`);
		return res.json();
	},

	async createSession(data?: { model?: OpenCodeModelSelection | null; title?: string }): Promise<OpenCodeSession> {
		const res = await fetch(`${OPENCODE_BASE}/session`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data || {}),
		});
		if (!res.ok) throw new Error("Failed to create session");
		return res.json();
	},

	async deleteSession(id: string): Promise<void> {
		const res = await fetch(`${OPENCODE_BASE}/session/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
		if (!res.ok) throw new Error(`Failed to delete session ${id}`);
	},

	async updateSession(id: string, data: { model?: OpenCodeModelSelection; title?: string }): Promise<OpenCodeSession> {
		const res = await fetch(`${OPENCODE_BASE}/session/${encodeURIComponent(id)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!res.ok) throw new Error(`Failed to update session ${id}`);
		return res.json();
	},

	async sendMessage(
		sessionId: string,
		contentOrParts: string | OpenCodePromptPart[],
		model?: OpenCodeModelSelection,
		system?: string,
		variant?: string,
	): Promise<any> {
		const res = await fetch(`${OPENCODE_BASE}/session/${encodeURIComponent(sessionId)}/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				parts: buildOpenCodePromptParts(contentOrParts),
				...(model && { model }),
				...(system && { system }),
				...(variant && { variant }),
			}),
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({ error: "Failed to send message" }));
			throw new Error(err.error || "Failed to send message");
		}
		return res.json();
	},

	async sendMessageAsync(
		sessionId: string,
		contentOrParts: string | OpenCodePromptPart[],
		model?: OpenCodeModelSelection,
		system?: string,
		variant?: string,
	): Promise<OpenCodeAsyncPromptResponse> {
		const res = await fetch(`${OPENCODE_BASE}/session/${encodeURIComponent(sessionId)}/prompt_async`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				parts: buildOpenCodePromptParts(contentOrParts),
				...(model && { model }),
				...(system && { system }),
				...(variant && { variant }),
			}),
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({ error: "Failed to queue message" }));
			throw new Error(err.error || "Failed to queue message");
		}
		if (res.status === 204) {
			return {};
		}
		const contentType = res.headers.get("content-type") || "";
		const contentLength = res.headers.get("content-length");
		if (contentLength === "0") {
			return {};
		}
		if (contentType.includes("application/json")) {
			return res.json();
		}
		return {};
	},

	async getMessages(sessionId: string): Promise<OpenCodeMessage[]> {
		const res = await fetch(`${OPENCODE_BASE}/session/${encodeURIComponent(sessionId)}/message`);
		if (!res.ok) throw new Error(`Failed to fetch messages for ${sessionId}`);
		return res.json();
	},

	async getTodos(sessionId: string): Promise<OpenCodeTodo[]> {
		const res = await fetch(`${OPENCODE_BASE}/session/${encodeURIComponent(sessionId)}/todo`);
		if (!res.ok) throw new Error(`Failed to fetch todos for ${sessionId}`);
		return res.json();
	},

	async listPendingQuestions(): Promise<OpenCodePendingQuestion[]> {
		const res = await fetch(`${OPENCODE_BASE}/question`);
		if (!res.ok) return [];
		return res.json();
	},

	async replyQuestion(questionId: string, payload: OpenCodeQuestionReplyPayload): Promise<unknown> {
		const res = await fetch(`${OPENCODE_BASE}/question/${encodeURIComponent(questionId)}/reply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({ error: "Failed to reply to question" }));
			throw new Error(err.error || "Failed to reply to question");
		}
		const contentType = res.headers.get("content-type") || "";
		if (contentType.includes("application/json")) {
			return res.json();
		}
		return null;
	},

	async rejectQuestion(questionId: string): Promise<unknown> {
		const res = await fetch(`${OPENCODE_BASE}/question/${encodeURIComponent(questionId)}/reject`, {
			method: "POST",
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({ error: "Failed to reject question" }));
			throw new Error(err.error || "Failed to reject question");
		}
		const contentType = res.headers.get("content-type") || "";
		if (contentType.includes("application/json")) {
			return res.json();
		}
		return null;
	},

	async listPendingPermissions(): Promise<OpenCodePendingPermission[]> {
		const res = await fetch(`${OPENCODE_BASE}/permission`);
		if (!res.ok) return [];
		return res.json();
	},

	async respondToPermission(
		sessionId: string,
		permissionId: string,
		response: OpenCodePermissionResponse,
	): Promise<unknown> {
		const res = await fetch(
			`${OPENCODE_BASE}/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(response),
			},
		);
		if (!res.ok) {
			const err = await res.json().catch(() => ({ error: "Failed to respond to permission" }));
			throw new Error(err.error || "Failed to respond to permission");
		}
		const contentType = res.headers.get("content-type") || "";
		if (contentType.includes("application/json")) {
			return res.json();
		}
		return null;
	},

	// Global event stream using SSE - subscribes to all events from OpenCode
	eventSource(): EventSource {
		return new EventSource(`${OPENCODE_BASE}/global/event`);
	},

	// Session-specific event stream (legacy)
	sessionEventSource(sessionId: string): EventSource {
		return new EventSource(`${OPENCODE_BASE}/event?sessionID=${encodeURIComponent(sessionId)}`);
	},

	// List available skills from OpenCode
	async listSkills(): Promise<Array<{
		name: string;
		description: string;
		location: string;
		content: string;
	}>> {
		const res = await fetch(`${OPENCODE_BASE}/skill`);
		if (!res.ok) throw new Error("Failed to fetch skills");
		return res.json();
	},

	async listCommands(directory?: string | null): Promise<OpenCodeCommandDefinition[]> {
		const res = await fetch(`${OPENCODE_BASE}/command`, {
			headers: getOpenCodeHeaders(directory),
		});
		if (!res.ok) throw new Error("Failed to fetch commands");
		return res.json();
	},

	async runCommand(sessionId: string, payload: OpenCodeRunCommandRequest): Promise<OpenCodeRunCommandResult> {
		const commandUrl = new URL(`${OPENCODE_BASE}/session/${encodeURIComponent(sessionId)}/command`, window.location.origin);
		if (payload.directory) {
			commandUrl.searchParams.set("directory", payload.directory);
		}

		const res = await fetch(commandUrl.toString(), {
			method: "POST",
			headers: getOpenCodeHeaders(payload.directory || null, "application/json"),
			body: JSON.stringify({
				arguments: "",
				agent: "build",
				parts: [],
				...payload,
				directory: undefined,
			}),
		});

		const { message, data } = await readOpenCodeResponsePayload(res);
		if (!res.ok) {
			if (message?.includes(OPENCODE_COMMAND_HANDLED_SENTINEL)) {
				return { handled: true, data };
			}
			throw new Error(message || "Failed to run command");
		}

		if (message?.includes(OPENCODE_COMMAND_HANDLED_SENTINEL)) {
			return { handled: true, data };
		}

		return { handled: false, data };
	},

	async summarizeSession(
		sessionId: string,
		payload: OpenCodeSummarizeSessionRequest,
		directory?: string | null,
	): Promise<unknown> {
		const res = await fetch(`${OPENCODE_BASE}/session/${encodeURIComponent(sessionId)}/summarize`, {
			method: "POST",
			headers: getOpenCodeHeaders(directory, "application/json"),
			body: JSON.stringify(payload),
		});

		if (!res.ok) {
			const { message } = await readOpenCodeResponsePayload(res);
			throw new Error(message || `Failed to summarize session ${sessionId}`);
		}

		const contentType = res.headers.get("content-type") || "";
		const contentLength = res.headers.get("content-length");
		if (res.status === 204 || contentLength === "0") {
			return null;
		}
		if (contentType.includes("application/json")) {
			return res.json();
		}
		return res.text();
	},

	// List available providers from OpenCode (for model selector)
	async listProviders(): Promise<OpenCodeProviderResponse> {
		const res = await fetch(`${OPENCODE_BASE}/provider`);
		if (!res.ok) throw new Error("Failed to fetch providers");
		return res.json();
	},

	// Get auth methods available for each provider
	async getProviderAuth(): Promise<Record<string, ProviderAuthMethod[]>> {
		const res = await fetch(`${OPENCODE_BASE}/provider/auth`);
		if (!res.ok) throw new Error("Failed to fetch provider auth methods");
		return res.json();
	},

	// Set credentials for a provider (API key or OAuth token)
	async setAuth(id: string, auth: OpenCodeAuth): Promise<boolean> {
		const res = await fetch(`${OPENCODE_BASE}/auth/${encodeURIComponent(id)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(auth),
		});
		if (!res.ok) throw new Error(`Failed to set auth for provider ${id}`);
		return res.json();
	},

	// Remove credentials for a provider (disconnect)
	async deleteAuth(id: string): Promise<boolean> {
		const res = await fetch(`${OPENCODE_BASE}/auth/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
		if (!res.ok) throw new Error(`Failed to disconnect provider ${id}`);
		return res.json();
	},

	// Initiate OAuth flow for a provider — returns authorization URL + method
	async oauthAuthorize(id: string, method: number): Promise<ProviderAuthAuthorization> {
		const res = await fetch(`${OPENCODE_BASE}/provider/${encodeURIComponent(id)}/oauth/authorize`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ method }),
		});
		if (!res.ok) throw new Error(`Failed to initiate OAuth for provider ${id}`);
		return res.json();
	},

	// Complete OAuth flow (code exchange or auto-detection)
	async oauthCallback(id: string, method: number, code?: string): Promise<boolean> {
		const res = await fetch(`${OPENCODE_BASE}/provider/${encodeURIComponent(id)}/oauth/callback`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ method, ...(code ? { code } : {}) }),
		});
		if (!res.ok) throw new Error(`Failed to complete OAuth for provider ${id}`);
		return res.json();
	},

	// Dispose global OpenCode instance
	async globalDispose(): Promise<void> {
		const res = await fetch(`${OPENCODE_BASE}/global/dispose`, { method: "POST" });
		if (!res.ok) throw new Error("Failed to dispose OpenCode instance");
	},

	// Patch OpenCode config (e.g. register custom providers)
	async patchConfig(config: Record<string, unknown>): Promise<void> {
		const res = await fetch(`${OPENCODE_BASE}/config`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(config),
		});
		if (!res.ok) throw new Error("Failed to update OpenCode config");
	},

	// Stop a running session via OpenCode abort endpoint
	async stopSession(id: string): Promise<void> {
		const res = await fetch(`${OPENCODE_BASE}/session/${encodeURIComponent(id)}/abort`, {
			method: "POST",
		});
		if (!res.ok) throw new Error(`Failed to stop session ${id}`);
	},

	async revertMessage(sessionId: string, messageId: string): Promise<void> {
		const res = await fetch(`${OPENCODE_BASE}/session/${encodeURIComponent(sessionId)}/revert`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messageID: messageId }),
		});
		if (!res.ok) throw new Error("Failed to revert message");
	},
};

// Status API
// Embedding Models API
export interface EmbeddingModelInfo {
	name: string;
	huggingFaceId?: string;
	dimensions: number;
	maxTokens?: number;
	installed?: boolean;
	source?: string;
	provider?: string;
	id?: string;
	model?: string;
}

export interface EmbeddingModelsResponse {
	local: EmbeddingModelInfo[];
	api: EmbeddingModelInfo[];
	configured: EmbeddingModelInfo[];
}

export async function getEmbeddingModels(): Promise<EmbeddingModelsResponse> {
	const res = await fetch(`${API_BASE}/api/embedding-models`);
	if (!res.ok) throw new Error("Failed to fetch embedding models");
	return res.json();
}

export interface EmbeddingModelTestResult {
	success: boolean;
	dimensions?: number;
	model?: string;
	error?: string;
}

export async function testEmbeddingModel(params: { apiBase: string; apiKey: string; model: string }): Promise<EmbeddingModelTestResult> {
	const res = await fetch(`${API_BASE}/api/embedding-models/test`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(params),
	});
	return res.json();
}

export interface ProjectStatus {
	active: boolean;
	projectName: string;
	projectPath: string;
	version: string;
}

export async function getProjectStatus(): Promise<ProjectStatus> {
	const res = await fetch(`${API_BASE}/api/status`);
	if (!res.ok) throw new Error("Failed to fetch status");
	return res.json();
}

// Workspace API
export interface WorkspaceProject {
	id: string;
	name: string;
	path: string;
	lastUsed: string;
}

export interface DirEntry {
	name: string;
	path: string;
	isProject: boolean;
	hasChildren: boolean;
}

export const workspaceApi = {
	async list(): Promise<WorkspaceProject[]> {
		const res = await fetch(`${API_BASE}/api/workspaces`);
		if (!res.ok) throw new Error("Failed to fetch workspaces");
		return res.json();
	},

	async switchProject(id: string): Promise<WorkspaceProject> {
		const res = await fetch(`${API_BASE}/api/workspaces/switch`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id }),
		});
		if (!res.ok) throw new Error("Failed to switch workspace");
		return res.json();
	},

	async switchByPath(path: string): Promise<WorkspaceProject> {
		const res = await fetch(`${API_BASE}/api/workspaces/switch`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path }),
		});
		if (!res.ok) throw new Error("Failed to switch workspace");
		return res.json();
	},

	async scan(dirs: string[]): Promise<WorkspaceProject[]> {
		const res = await fetch(`${API_BASE}/api/workspaces/scan`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ dirs }),
		});
		if (!res.ok) throw new Error("Failed to scan workspaces");
		return res.json();
	},

	async remove(id: string): Promise<void> {
		const res = await fetch(`${API_BASE}/api/workspaces/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
		if (!res.ok) throw new Error("Failed to remove workspace");
	},

	async autoScan(): Promise<WorkspaceProject[]> {
		const res = await fetch(`${API_BASE}/api/workspaces/auto-scan`, {
			method: "POST",
		});
		if (!res.ok) throw new Error("Failed to auto-scan workspaces");
		return res.json();
	},

	async browse(path?: string): Promise<DirEntry[]> {
		const url = path
			? `${API_BASE}/api/workspaces/browse?path=${encodeURIComponent(path)}`
			: `${API_BASE}/api/workspaces/browse`;
		const res = await fetch(url);
		if (!res.ok) throw new Error("Failed to browse directory");
		return res.json();
	},
};

// --- Graph API ---

export interface GraphNode {
	id: string;
	type: "task" | "doc" | "template" | "memory" | "code";
	label: string;
	data: Record<string, unknown>;
}

export interface GraphEdge {
	source: string;
	target: string;
	type:
		| "parent"
		| "spec"
		| "template-doc"
		| "mention"
		| "code-ref"
		| "calls"
		| "imports"
		| "contains"
		| "instantiates"
		| "implements"
		| "references"
		| "blocked-by"
		| "related"
		| "depends"
		| "follows";
	data?: Record<string, unknown>;
}

export interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export async function getGraph(): Promise<GraphData> {
	const res = await fetch(`${API_BASE}/api/graph`);
	if (!res.ok) throw new Error("Failed to fetch graph");
	return res.json();
}


export interface SemanticDocReferenceFragment {
	raw?: string;
	line?: number;
	rangeStart?: number;
	rangeEnd?: number;
	heading?: string;
}

export interface SemanticReference {
	raw: string;
	type: string;
	target: string;
	relation: string;
	explicitRelation?: boolean;
	validRelation: boolean;
	fragment?: SemanticDocReferenceFragment;
}

export interface ResolvedEntity {
	type: string;
	id: string;
	path?: string;
	title?: string;
	status?: string;
	priority?: string;
	tags?: string[];
	memoryLayer?: string;
	category?: string;
	imported?: boolean;
	source?: string;
}

export interface SemanticResolution {
	reference: SemanticReference;
	entity?: ResolvedEntity;
	found: boolean;
}

export async function resolveReference(ref: string): Promise<SemanticResolution> {
	const params = new URLSearchParams({ ref });
	const res = await fetch(`${API_BASE}/api/resolve?${params.toString()}`);
	if (!res.ok) {
		throw new Error(`Failed to resolve reference ${ref}`);
	}
	return res.json();
}

// --- Memory API ---

export type PersistentMemoryLayer = "project" | "global";

export interface MemoryEntry {
	id: string;
	title: string;
	content: string;
	layer: "working" | PersistentMemoryLayer;
	category?: string;
	tags?: string[];
	metadata?: Record<string, string>;
	createdAt: string;
	updatedAt: string;
}

export const memoryApi = {
	async list(layer?: PersistentMemoryLayer): Promise<MemoryEntry[]> {
		const params = new URLSearchParams();
		if (layer) params.set("layer", layer);
		const res = await fetch(`${API_BASE}/api/memories?${params.toString()}`);
		if (!res.ok) throw new Error("Failed to fetch memories");
		return res.json();
	},

	async get(id: string): Promise<MemoryEntry> {
		const res = await fetch(`${API_BASE}/api/memories/${encodeURIComponent(id)}`);
		if (!res.ok) throw new Error(`Failed to fetch memory ${id}`);
		return res.json();
	},

	async create(data: Partial<MemoryEntry>): Promise<MemoryEntry> {
		const res = await fetch(`${API_BASE}/api/memories`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!res.ok) throw new Error("Failed to create memory");
		return res.json();
	},

	async update(id: string, data: Partial<MemoryEntry>): Promise<MemoryEntry> {
		const res = await fetch(`${API_BASE}/api/memories/${encodeURIComponent(id)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!res.ok) throw new Error(`Failed to update memory ${id}`);
		return res.json();
	},

	async delete(id: string): Promise<void> {
		const res = await fetch(`${API_BASE}/api/memories/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
		if (!res.ok) throw new Error(`Failed to delete memory ${id}`);
	},

	async promote(id: string): Promise<MemoryEntry> {
		const res = await fetch(`${API_BASE}/api/memories/${encodeURIComponent(id)}/promote`, {
			method: "POST",
		});
		if (!res.ok) throw new Error(`Failed to promote memory ${id}`);
		return res.json();
	},

	async demote(id: string): Promise<MemoryEntry> {
		const res = await fetch(`${API_BASE}/api/memories/${encodeURIComponent(id)}/demote`, {
			method: "POST",
		});
		if (!res.ok) throw new Error(`Failed to demote memory ${id}`);
		return res.json();
	},
};

export const workingMemoryApi = {
	async list(): Promise<MemoryEntry[]> {
		const res = await fetch(`${API_BASE}/api/working-memories`);
		if (!res.ok) throw new Error("Failed to fetch working memory");
		return res.json();
	},

	async get(id: string): Promise<MemoryEntry> {
		const res = await fetch(`${API_BASE}/api/working-memories/${encodeURIComponent(id)}`);
		if (!res.ok) throw new Error(`Failed to fetch working memory ${id}`);
		return res.json();
	},

	async create(data: Partial<MemoryEntry>): Promise<MemoryEntry> {
		const res = await fetch(`${API_BASE}/api/working-memories`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!res.ok) throw new Error("Failed to create working memory");
		return res.json();
	},

	async delete(id: string): Promise<void> {
		const res = await fetch(`${API_BASE}/api/working-memories/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
		if (!res.ok) throw new Error(`Failed to delete working memory ${id}`);
	},

	async clean(): Promise<{ cleaned: number }> {
		const res = await fetch(`${API_BASE}/api/working-memories/clean`, {
			method: "POST",
		});
		if (!res.ok) throw new Error("Failed to clear working memory");
		return res.json();
	},
};

// ─── Audit API ───────────────────────────────────────────────────────

export interface AuditEvent {
	timestamp: string;
	toolName: string;
	action?: string;
	actionClass: string;
	projectRoot?: string;
	dryRun?: boolean;
	result: string;
	durationMs: number;
	errorMessage?: string;
	entityRefs?: string[];
	argumentSummary?: Record<string, string>;
}

export interface AuditStats {
	totalCalls: number;
	byTool: Record<string, number>;
	byActionClass: Record<string, number>;
	byResult: Record<string, number>;
	dryRunCount: number;
	executeCount: number;
	byToolResult: Record<string, Record<string, number>>;
}

export const auditApi = {
	async recent(options?: {
		limit?: number;
		tool?: string;
		result?: string;
		project?: string;
	}): Promise<{ events: AuditEvent[]; count: number }> {
		const params = new URLSearchParams();
		if (options?.limit) params.set("limit", String(options.limit));
		if (options?.tool) params.set("tool", options.tool);
		if (options?.result) params.set("result", options.result);
		if (options?.project) params.set("project", options.project);

		const res = await fetch(`${API_BASE}/api/audit/recent?${params.toString()}`);
		if (!res.ok) throw new Error("Failed to fetch audit events");
		return res.json();
	},

	async stats(options?: {
		tool?: string;
		project?: string;
	}): Promise<AuditStats> {
		const params = new URLSearchParams();
		if (options?.tool) params.set("tool", options.tool);
		if (options?.project) params.set("project", options.project);

		const res = await fetch(`${API_BASE}/api/audit/stats?${params.toString()}`);
		if (!res.ok) throw new Error("Failed to fetch audit stats");
		return res.json();
	},
};
