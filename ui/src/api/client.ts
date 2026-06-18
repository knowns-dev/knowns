import type { Task, TimeEntry } from "@/ui/models/task";
import type { TaskChange, TaskVersion } from "@/ui/models/version";

// Use env vars from Vite, fallback to relative paths for production
const API_BASE = import.meta.env.API_URL || "";

// Wrapper that always sends credentials (cookies) with requests
function apiFetch(input: string, init?: RequestInit): Promise<Response> {
	return fetch(input, { ...init, credentials: "include" });
}

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
		const res = await apiFetch(`${API_BASE}/api/tasks`);
		if (!res.ok) {
			throw new Error("Failed to fetch tasks");
		}
		const data = (await res.json()) as TaskDTO[];
		return data.map(parseTaskDTO);
	},

	async getTask(id: string): Promise<Task> {
		const res = await apiFetch(`${API_BASE}/api/tasks/${id}`);
		if (!res.ok) {
			throw new Error(`Failed to fetch task ${id}`);
		}
		const dto = (await res.json()) as TaskDTO;
		return parseTaskDTO(dto);
	},

	async updateTask(id: string, updates: Partial<Task>): Promise<Task> {
		const res = await apiFetch(`${API_BASE}/api/tasks/${id}`, {
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
		const res = await apiFetch(`${API_BASE}/api/tasks`, {
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
		const res = await apiFetch(`${API_BASE}/api/tasks/${id}/history`);
		if (!res.ok) {
			throw new Error(`Failed to fetch history for task ${id}`);
		}
		const data = (await res.json()) as TaskVersionDTO[] | { versions: TaskVersionDTO[] };
		const versions = Array.isArray(data) ? data : data.versions || [];
		return versions.map(parseVersionDTO);
	},

	async archiveTask(id: string): Promise<{ success: boolean; task: Task }> {
		const res = await apiFetch(`${API_BASE}/api/tasks/${id}/archive`, {
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
		const res = await apiFetch(`${API_BASE}/api/tasks/${id}/unarchive`, {
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
		const res = await apiFetch(`${API_BASE}/api/tasks/batch-archive`, {
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
		const res = await apiFetch(`${API_BASE}/api/tasks/reorder`, {
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

		const res = await apiFetch(`${API_BASE}/api/activities?${params.toString()}`);
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
export interface LSPLanguageInfo {
	id: string;
	name: string;
	status?: string;
	binary: string;
	binaryPath?: string;
	source?: string;
	installed: boolean;
	running: boolean;
	installState?: string;
	runningState?: string;
	readinessState?: string;
	version?: string;
	cachePath?: string;
	selectedPath?: string;
	cleanupEligible?: boolean;
	installError?: string;
	updateError?: string;
	installHint?: string;
	backend?: string;
	backendSource?: string;
	projectPath?: string;
	projectKind?: string;
	logPath?: string;
	traceEnabled?: boolean;
	attempts?: Array<{ backend: string; status: string; reason?: string }>;
}

export interface LSPLanguageConfigPatch {
	backend?: string;
	projectPath?: string;
	version?: string;
	binary?: string;
	settings?: Record<string, unknown>;
	apply?: boolean;
}

export interface LSPActionResponse {
	language: string;
	status: string;
	action: string;
	info?: LSPLanguageInfo;
	error?: string;
}

export interface LSPLogResponse {
	language: string;
	kind: "runtime" | "trace";
	logPath: string;
	content: string;
}

async function parseLSPActionResponse<T extends { error?: string }>(res: Response, fallback: string): Promise<T> {
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.error) {
		throw new Error(data.error || fallback);
	}
	return data as T;
}

export const lspApi = {
	async getLanguages(): Promise<{ languages: LSPLanguageInfo[] }> {
		const res = await apiFetch(`${API_BASE}/api/lsp/languages`);
		if (!res.ok) throw new Error("Failed to fetch LSP languages");
		return res.json();
	},

	async addLanguage(language: string): Promise<{ language: string; status: string; action: string }> {
		const res = await apiFetch(`${API_BASE}/api/lsp/languages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ language }),
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || "Failed to add LSP language");
		}
		return res.json();
	},

	async toggleLanguage(lang: string, enabled: boolean): Promise<{ language: string; status: string; action: string }> {
		const res = await apiFetch(`${API_BASE}/api/lsp/languages/${encodeURIComponent(lang)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled }),
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || "Failed to toggle LSP language");
		}
		return res.json();
	},

	async removeLanguage(lang: string): Promise<{ language: string; status: string; action: string }> {
		const res = await apiFetch(`${API_BASE}/api/lsp/languages/${encodeURIComponent(lang)}`, {
			method: "DELETE",
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || "Failed to remove LSP language");
		}
		return res.json();
	},

	async restartLanguage(lang: string): Promise<LSPActionResponse> {
		const res = await apiFetch(`${API_BASE}/api/lsp/languages/${encodeURIComponent(lang)}/restart`, {
			method: "POST",
		});
		return parseLSPActionResponse<LSPActionResponse>(res, "Failed to restart LSP language");
	},

	async updateLanguageConfig(lang: string, patch: LSPLanguageConfigPatch): Promise<LSPActionResponse> {
		const res = await apiFetch(`${API_BASE}/api/lsp/languages/${encodeURIComponent(lang)}/config`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(patch),
		});
		return parseLSPActionResponse<LSPActionResponse>(res, "Failed to update LSP language config");
	},

	async installLanguage(lang: string, action: "install" | "update" = "install"): Promise<LSPActionResponse> {
		const res = await apiFetch(`${API_BASE}/api/lsp/languages/${encodeURIComponent(lang)}/install`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action }),
		});
		return parseLSPActionResponse<LSPActionResponse>(res, `Failed to ${action} LSP dependency`);
	},

	async cleanupLanguage(lang: string): Promise<LSPActionResponse> {
		const res = await apiFetch(`${API_BASE}/api/lsp/languages/${encodeURIComponent(lang)}/cleanup`, {
			method: "POST",
		});
		return parseLSPActionResponse<LSPActionResponse>(res, "Failed to cleanup LSP dependency");
	},

	async getLanguageLogs(lang: string, kind: "runtime" | "trace" = "runtime", tail = 200): Promise<LSPLogResponse> {
		const params = new URLSearchParams({ kind, tail: String(tail) });
		const res = await apiFetch(`${API_BASE}/api/lsp/languages/${encodeURIComponent(lang)}/logs?${params}`);
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || "Failed to fetch LSP logs");
		}
		return res.json();
	},

	async setLanguageTrace(lang: string, enabled: boolean): Promise<LSPActionResponse & { enabled: boolean; tracePath?: string }> {
		const res = await apiFetch(`${API_BASE}/api/lsp/languages/${encodeURIComponent(lang)}/trace`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled }),
		});
		return parseLSPActionResponse<LSPActionResponse & { enabled: boolean; tracePath?: string }>(res, "Failed to update LSP trace");
	},
};

export async function getConfig(): Promise<Record<string, unknown>> {
	const res = await apiFetch(`${API_BASE}/api/config`);
	if (!res.ok) {
		throw new Error("Failed to fetch config");
	}
	const data = await res.json();
	return data.config || {};
}

export async function saveConfig(config: Record<string, unknown>): Promise<void> {
	const res = await apiFetch(`${API_BASE}/api/config`, {
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
	const res = await apiFetch(`${API_BASE}/api/user-preferences`);
	if (!res.ok) {
		throw new Error("Failed to fetch user preferences");
	}
	return res.json();
}

export async function saveUserPreferences(prefs: Record<string, unknown>): Promise<void> {
	const res = await apiFetch(`${API_BASE}/api/user-preferences`, {
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
	const res = await apiFetch(`${API_BASE}/api/docs`);
	if (!res.ok) {
		throw new Error("Failed to fetch docs");
	}
	const data = await res.json();
	return data.docs || [];
}

export async function getDoc(path: string): Promise<Doc | null> {
	// Encode each path segment separately to preserve '/' for the wildcard route.
	const encodedPath = path.split("/").map(encodeURIComponent).join("/");
	const res = await apiFetch(`${API_BASE}/api/docs/${encodedPath}`);
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
	const res = await apiFetch(`${API_BASE}/api/docs`, {
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
	const res = await apiFetch(`${API_BASE}/api/docs/${encodedPath}`, {
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
	const res = await apiFetch(`${API_BASE}/api/search?q=${encodeURIComponent(query)}`);
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
	const res = await apiFetch(`${API_BASE}/api/validate/sdd`);
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
	const res = await apiFetch(`${API_BASE}/api/runtime/ps`);
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
	const res = await apiFetch(`${API_BASE}/api/runtime/services`);
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
		const res = await apiFetch(`${API_BASE}/api/imports`);
		if (!res.ok) {
			throw new Error("Failed to fetch imports");
		}
		return res.json();
	},

	async get(name: string): Promise<{ import: ImportDetail }> {
		const res = await apiFetch(`${API_BASE}/api/imports/${encodeURIComponent(name)}`);
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
		const res = await apiFetch(`${API_BASE}/api/imports`, {
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
		const res = await apiFetch(`${API_BASE}/api/imports/${encodeURIComponent(name)}/sync`, {
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
		const res = await apiFetch(`${API_BASE}/api/imports/sync-all`, {
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
		const res = await apiFetch(`${API_BASE}/api/imports/${encodeURIComponent(name)}?delete=${deleteFiles}`, {
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
		const res = await apiFetch(`${API_BASE}/api/time/status`);
		if (!res.ok) {
			throw new Error("Failed to fetch time status");
		}
		return res.json();
	},

	async start(taskId: string): Promise<{ success: boolean; active: ActiveTimer[]; timer: ActiveTimer }> {
		const res = await apiFetch(`${API_BASE}/api/time/start`, {
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
		const res = await apiFetch(`${API_BASE}/api/time/stop`, {
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
		const res = await apiFetch(`${API_BASE}/api/time/pause`, {
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
		const res = await apiFetch(`${API_BASE}/api/time/resume`, {
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
		const res = await apiFetch(`${API_BASE}/api/chats`);
		if (!res.ok) throw new Error("Failed to fetch chat sessions");
		return res.json();
	},

	async getSession(id: string): Promise<ChatSession> {
		const res = await apiFetch(`${API_BASE}/api/chats/${encodeURIComponent(id)}`);
		if (!res.ok) throw new Error(`Failed to fetch chat session ${id}`);
		return res.json();
	},

	async createSession(data: {
		agentType: string;
		model?: string;
		title?: string;
		taskId?: string;
	}): Promise<ChatSession> {
		const res = await apiFetch(`${API_BASE}/api/chats`, {
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
		const res = await apiFetch(`${API_BASE}/api/chats/${encodeURIComponent(id)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!res.ok) throw new Error("Failed to update session");
		return res.json();
	},

	async deleteSession(id: string): Promise<void> {
		const res = await apiFetch(`${API_BASE}/api/chats/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
		if (!res.ok) throw new Error("Failed to delete session");
	},

	async sendMessage(id: string, content: string): Promise<{ status: string; message: unknown }> {
		const res = await apiFetch(`${API_BASE}/api/chats/${encodeURIComponent(id)}/send`, {
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
		const res = await apiFetch(`${API_BASE}/api/chats/${encodeURIComponent(id)}/stop`, {
			method: "POST",
		});
		if (!res.ok) throw new Error("Failed to stop chat");
	},

	async getQueue(id: string): Promise<{ queueSize: number; maxSize: number; messages: string[] }> {
		const res = await apiFetch(`${API_BASE}/api/chats/${encodeURIComponent(id)}/queue`);
		if (!res.ok) throw new Error("Failed to get queue");
		return res.json();
	},

	async processQueue(id: string): Promise<{ hasMore: boolean; message: string; queueSize: number }> {
		const res = await apiFetch(`${API_BASE}/api/chats/${encodeURIComponent(id)}/process-queue`, {
			method: "POST",
		});
		if (!res.ok) throw new Error("Failed to process queue");
		return res.json();
	},

	async getAgents(): Promise<{ agents: AgentInfo[]; models: AgentModelDef[] }> {
		const res = await apiFetch(`${API_BASE}/api/chats/agents`);
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
		const res = await apiFetch(`${OPENCODE_BASE}/status`);
		if (!res.ok) throw new Error("Failed to fetch OpenCode status");
		return res.json();
	},

	async listSessions(): Promise<OpenCodeSession[]> {
		const res = await apiFetch(`${OPENCODE_BASE}/session`);
		if (!res.ok) throw new Error("Failed to fetch sessions");
		return res.json();
	},

	async getSession(id: string): Promise<OpenCodeSession> {
		const res = await apiFetch(`${OPENCODE_BASE}/session/${encodeURIComponent(id)}`);
		if (!res.ok) throw new Error(`Failed to fetch session ${id}`);
		return res.json();
	},

	async createSession(data?: { model?: OpenCodeModelSelection | null; title?: string }): Promise<OpenCodeSession> {
		const res = await apiFetch(`${OPENCODE_BASE}/session`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data || {}),
		});
		if (!res.ok) throw new Error("Failed to create session");
		return res.json();
	},

	async deleteSession(id: string): Promise<void> {
		const res = await apiFetch(`${OPENCODE_BASE}/session/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
		if (!res.ok) throw new Error(`Failed to delete session ${id}`);
	},

	async updateSession(id: string, data: { model?: OpenCodeModelSelection; title?: string }): Promise<OpenCodeSession> {
		const res = await apiFetch(`${OPENCODE_BASE}/session/${encodeURIComponent(id)}`, {
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
		const res = await apiFetch(`${OPENCODE_BASE}/session/${encodeURIComponent(sessionId)}/message`, {
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
		const res = await apiFetch(`${OPENCODE_BASE}/session/${encodeURIComponent(sessionId)}/prompt_async`, {
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
		const res = await apiFetch(`${OPENCODE_BASE}/session/${encodeURIComponent(sessionId)}/message`);
		if (!res.ok) throw new Error(`Failed to fetch messages for ${sessionId}`);
		return res.json();
	},

	async getTodos(sessionId: string): Promise<OpenCodeTodo[]> {
		const res = await apiFetch(`${OPENCODE_BASE}/session/${encodeURIComponent(sessionId)}/todo`);
		if (!res.ok) throw new Error(`Failed to fetch todos for ${sessionId}`);
		return res.json();
	},

	async listPendingQuestions(): Promise<OpenCodePendingQuestion[]> {
		const res = await apiFetch(`${OPENCODE_BASE}/question`);
		if (!res.ok) return [];
		return res.json();
	},

	async replyQuestion(questionId: string, payload: OpenCodeQuestionReplyPayload): Promise<unknown> {
		const res = await apiFetch(`${OPENCODE_BASE}/question/${encodeURIComponent(questionId)}/reply`, {
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
		const res = await apiFetch(`${OPENCODE_BASE}/question/${encodeURIComponent(questionId)}/reject`, {
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
		const res = await apiFetch(`${OPENCODE_BASE}/permission`);
		if (!res.ok) return [];
		return res.json();
	},

	async respondToPermission(
		sessionId: string,
		permissionId: string,
		response: OpenCodePermissionResponse,
	): Promise<unknown> {
		const res = await apiFetch(
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
		const res = await apiFetch(`${OPENCODE_BASE}/skill`);
		if (!res.ok) throw new Error("Failed to fetch skills");
		return res.json();
	},

	async listCommands(directory?: string | null): Promise<OpenCodeCommandDefinition[]> {
		const res = await apiFetch(`${OPENCODE_BASE}/command`, {
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

		const res = await apiFetch(commandUrl.toString(), {
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
		const res = await apiFetch(`${OPENCODE_BASE}/session/${encodeURIComponent(sessionId)}/summarize`, {
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
		const res = await apiFetch(`${OPENCODE_BASE}/provider`);
		if (!res.ok) throw new Error("Failed to fetch providers");
		return res.json();
	},

	// Get auth methods available for each provider
	async getProviderAuth(): Promise<Record<string, ProviderAuthMethod[]>> {
		const res = await apiFetch(`${OPENCODE_BASE}/provider/auth`);
		if (!res.ok) throw new Error("Failed to fetch provider auth methods");
		return res.json();
	},

	// Set credentials for a provider (API key or OAuth token)
	async setAuth(id: string, auth: OpenCodeAuth): Promise<boolean> {
		const res = await apiFetch(`${OPENCODE_BASE}/auth/${encodeURIComponent(id)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(auth),
		});
		if (!res.ok) throw new Error(`Failed to set auth for provider ${id}`);
		return res.json();
	},

	// Remove credentials for a provider (disconnect)
	async deleteAuth(id: string): Promise<boolean> {
		const res = await apiFetch(`${OPENCODE_BASE}/auth/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
		if (!res.ok) throw new Error(`Failed to disconnect provider ${id}`);
		return res.json();
	},

	// Initiate OAuth flow for a provider — returns authorization URL + method
	async oauthAuthorize(id: string, method: number): Promise<ProviderAuthAuthorization> {
		const res = await apiFetch(`${OPENCODE_BASE}/provider/${encodeURIComponent(id)}/oauth/authorize`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ method }),
		});
		if (!res.ok) throw new Error(`Failed to initiate OAuth for provider ${id}`);
		return res.json();
	},

	// Complete OAuth flow (code exchange or auto-detection)
	async oauthCallback(id: string, method: number, code?: string): Promise<boolean> {
		const res = await apiFetch(`${OPENCODE_BASE}/provider/${encodeURIComponent(id)}/oauth/callback`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ method, ...(code ? { code } : {}) }),
		});
		if (!res.ok) throw new Error(`Failed to complete OAuth for provider ${id}`);
		return res.json();
	},

	// Dispose global OpenCode instance
	async globalDispose(): Promise<void> {
		const res = await apiFetch(`${OPENCODE_BASE}/global/dispose`, { method: "POST" });
		if (!res.ok) throw new Error("Failed to dispose OpenCode instance");
	},

	// Patch OpenCode config (e.g. register custom providers)
	async patchConfig(config: Record<string, unknown>): Promise<void> {
		const res = await apiFetch(`${OPENCODE_BASE}/config`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(config),
		});
		if (!res.ok) throw new Error("Failed to update OpenCode config");
	},

	// Stop a running session via OpenCode abort endpoint
	async stopSession(id: string): Promise<void> {
		const res = await apiFetch(`${OPENCODE_BASE}/session/${encodeURIComponent(id)}/abort`, {
			method: "POST",
		});
		if (!res.ok) throw new Error(`Failed to stop session ${id}`);
	},

	async revertMessage(sessionId: string, messageId: string): Promise<void> {
		const res = await apiFetch(`${OPENCODE_BASE}/session/${encodeURIComponent(sessionId)}/revert`, {
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
	const res = await apiFetch(`${API_BASE}/api/embedding-models`);
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
	const res = await apiFetch(`${API_BASE}/api/embedding-models/test`, {
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
	const res = await apiFetch(`${API_BASE}/api/status`);
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
		const res = await apiFetch(`${API_BASE}/api/workspaces`);
		if (!res.ok) throw new Error("Failed to fetch workspaces");
		return res.json();
	},

	async switchProject(id: string): Promise<WorkspaceProject> {
		const res = await apiFetch(`${API_BASE}/api/workspaces/switch`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id }),
		});
		if (!res.ok) throw new Error("Failed to switch workspace");
		return res.json();
	},

	async switchByPath(path: string): Promise<WorkspaceProject> {
		const res = await apiFetch(`${API_BASE}/api/workspaces/switch`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path }),
		});
		if (!res.ok) throw new Error("Failed to switch workspace");
		return res.json();
	},

	async scan(dirs: string[]): Promise<WorkspaceProject[]> {
		const res = await apiFetch(`${API_BASE}/api/workspaces/scan`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ dirs }),
		});
		if (!res.ok) throw new Error("Failed to scan workspaces");
		return res.json();
	},

	async remove(id: string): Promise<void> {
		const res = await apiFetch(`${API_BASE}/api/workspaces/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
		if (!res.ok) throw new Error("Failed to remove workspace");
	},

	async autoScan(): Promise<WorkspaceProject[]> {
		const res = await apiFetch(`${API_BASE}/api/workspaces/auto-scan`, {
			method: "POST",
		});
		if (!res.ok) throw new Error("Failed to auto-scan workspaces");
		return res.json();
	},

	async browse(path?: string): Promise<DirEntry[]> {
		const url = path
			? `${API_BASE}/api/workspaces/browse?path=${encodeURIComponent(path)}`
			: `${API_BASE}/api/workspaces/browse`;
		const res = await apiFetch(url);
		if (!res.ok) throw new Error("Failed to browse directory");
		return res.json();
	},
};

// --- Graph API ---

export interface GraphNode {
	id: string;
	type: "task" | "doc" | "template" | "memory" | "decision" | "code";
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
	const res = await apiFetch(`${API_BASE}/api/graph`);
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
	canonical: string;
	type: string;
	target: string;
	relation: string;
	explicitRelation?: boolean;
	validRelation: boolean;
	legacy?: boolean;
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
	const res = await apiFetch(`${API_BASE}/api/resolve?${params.toString()}`);
	if (!res.ok) {
		throw new Error(`Failed to resolve reference ${ref}`);
	}
	return res.json();
}

// --- Decision API ---

export type DecisionStatus = "draft" | "accepted" | "superseded" | "rejected" | "archived";
export type DecisionReviewResolution =
	| "supersede_existing"
	| "create_draft"
	| "link_as_related"
	| "reject_new";

export interface DecisionEntry {
	id: string;
	title: string;
	status: DecisionStatus;
	supersedes?: string[];
	supersededBy?: string[];
	tags?: string[];
	sources?: string[];
	relatedDocs?: string[];
	relatedTasks?: string[];
	createdAt: string;
	updatedAt: string;
	context?: string;
	decision?: string;
	alternativesConsidered?: string;
	consequences?: string;
	content?: string;
}

export interface DecisionReviewMatch {
	id: string;
	title: string;
	status?: DecisionStatus;
	score: number;
	kind?: "duplicate" | "conflict" | string;
	matchedBy?: string[];
	snippet?: string;
	tags?: string[];
}

export interface DecisionReviewResult {
	status: "created" | "review_required" | "resolved";
	resolution?: DecisionReviewResolution;
	candidate?: DecisionEntry;
	matches?: DecisionReviewMatch[];
	allowedResolutions?: DecisionReviewResolution[];
	decision?: DecisionEntry;
	superseded?: DecisionEntry;
	current?: DecisionEntry;
	changedIds?: string[];
}

export interface DecisionResolveRequest extends Partial<DecisionEntry> {
	resolution: DecisionReviewResolution;
	targetId?: string;
	replacementId?: string;
	status?: DecisionStatus;
}

export class DecisionReviewRequiredError extends Error {
	result: DecisionReviewResult;

	constructor(result: DecisionReviewResult) {
		super("Decision review required");
		this.name = "DecisionReviewRequiredError";
		this.result = result;
	}
}

export const decisionApi = {
	async list(options?: { status?: DecisionStatus; includeAll?: boolean; tag?: string }): Promise<DecisionEntry[]> {
		const params = new URLSearchParams();
		if (options?.status) params.set("status", options.status);
		if (options?.includeAll) params.set("includeAll", "true");
		if (options?.tag) params.set("tag", options.tag);
		const query = params.toString();
		const res = await apiFetch(`${API_BASE}/api/decisions${query ? `?${query}` : ""}`);
		if (!res.ok) throw new Error("Failed to fetch decisions");
		return res.json();
	},

	async get(id: string): Promise<DecisionEntry> {
		const res = await apiFetch(`${API_BASE}/api/decisions/${encodeURIComponent(id)}`);
		if (!res.ok) throw new Error(`Failed to fetch decision ${id}`);
		return res.json();
	},

	async create(data: Partial<DecisionEntry>): Promise<DecisionEntry> {
		const res = await apiFetch(`${API_BASE}/api/decisions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (res.status === 409) {
			const result = (await res.json()) as DecisionReviewResult;
			throw new DecisionReviewRequiredError(result);
		}
		if (!res.ok) {
			const error = await res.json().catch(() => ({ error: "Failed to create decision" }));
			throw new Error(error.error || "Failed to create decision");
		}
		return res.json();
	},

	async supersede(oldId: string, newId: string): Promise<{ superseded: DecisionEntry; current: DecisionEntry }> {
		const res = await apiFetch(`${API_BASE}/api/decisions/${encodeURIComponent(oldId)}/supersede`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ newId }),
		});
		if (!res.ok) {
			const error = await res.json().catch(() => ({ error: `Failed to supersede decision ${oldId}` }));
			throw new Error(error.error || `Failed to supersede decision ${oldId}`);
		}
		return res.json();
	},

	async resolveReview(data: DecisionResolveRequest): Promise<DecisionReviewResult> {
		const res = await apiFetch(`${API_BASE}/api/decisions/review/resolve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!res.ok) {
			const error = await res.json().catch(() => ({ error: "Failed to resolve decision review" }));
			throw new Error(error.error || "Failed to resolve decision review");
		}
		return res.json();
	},
};

// --- Memory API ---

export type PersistentMemoryLayer = "project" | "global";

export interface MemoryEntry {
	id: string;
	title: string;
	content: string;
	layer: "working" | PersistentMemoryLayer;
	category?: string;
	status?: MemoryStatus;
	confidence?: MemoryConfidence;
	lastVerified?: string;
	ttlDays?: number;
	sources?: string[];
	mergedInto?: string;
	rejectedReason?: string;
	tags?: string[];
	metadata?: Record<string, string>;
	lifecycleMetadataMissing?: string[];
	createdAt: string;
	updatedAt: string;
}

export type MemoryStatus = "proposed" | "active" | "stale" | "deprecated" | "archived" | "rejected" | "merged";
export type MemoryConfidence = "low" | "medium" | "high";
export type MemoryReviewReason =
	| "proposed"
	| "duplicate_review"
	| "stale_ttl"
	| "missing_source"
	| "source_missing"
	| "source_decision_superseded";
export type MemoryBulkAction = "verify" | "archive" | "reject_proposed";
export type MemoryItemAction = "verify" | "archive" | "reject" | "link_source" | "repair_source";
export type MemoryReviewResolution =
	| "update_existing"
	| "archive_existing_create_new"
	| "create_proposed"
	| "reject_new"
	| "merge_existing";

export interface MemoryReviewMatch {
	id: string;
	title: string;
	layer: PersistentMemoryLayer;
	category?: string;
	status?: MemoryStatus;
	score: number;
	matchedBy?: string[];
	snippet?: string;
	tags?: string[];
}

export interface MemoryReviewResult {
	status: "created" | "review_required" | "resolved";
	resolution?: MemoryReviewResolution;
	candidate?: MemoryEntry;
	matches?: MemoryReviewMatch[];
	allowedResolutions?: MemoryReviewResolution[];
	memory?: MemoryEntry;
	changedIds?: string[];
}

export interface MemoryReviewIssue {
	code: string;
	message: string;
	source?: string;
	targetId?: string;
	replacementId?: string;
}

export interface MemorySourceRepair {
	source: string;
	replacement: string;
	decisionId: string;
	replacementDecisionId: string;
}

export interface MemoryReviewItem {
	memory: MemoryEntry;
	reasons: MemoryReviewReason[];
	issues?: MemoryReviewIssue[];
	matches?: MemoryReviewMatch[];
	repairSources?: MemorySourceRepair[];
}

export interface MemoryReviewInboxResponse {
	memories: MemoryEntry[];
	items: MemoryReviewItem[];
	counts: Record<MemoryReviewReason, number>;
}

export interface MemoryResolveRequest extends Partial<MemoryEntry> {
	resolution: MemoryReviewResolution;
	targetId?: string;
	status?: MemoryStatus;
	rejectedReason?: string;
}

export interface MemoryActionRequest {
	action: MemoryItemAction;
	sources?: string[];
	source?: string;
	replacement?: string;
	rejectedReason?: string;
}

export class MemoryReviewRequiredError extends Error {
	result: MemoryReviewResult;

	constructor(result: MemoryReviewResult) {
		super("Memory review required");
		this.name = "MemoryReviewRequiredError";
		this.result = result;
	}
}

export const memoryApi = {
	async list(layer?: PersistentMemoryLayer): Promise<MemoryEntry[]> {
		const params = new URLSearchParams();
		if (layer) params.set("layer", layer);
		const res = await apiFetch(`${API_BASE}/api/memories?${params.toString()}`);
		if (!res.ok) throw new Error("Failed to fetch memories");
		return res.json();
	},

	async get(id: string): Promise<MemoryEntry> {
		const res = await apiFetch(`${API_BASE}/api/memories/${encodeURIComponent(id)}`);
		if (!res.ok) throw new Error(`Failed to fetch memory ${id}`);
		return res.json();
	},

	async create(data: Partial<MemoryEntry> & { skipReview?: boolean }): Promise<MemoryEntry> {
		const res = await apiFetch(`${API_BASE}/api/memories`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (res.status === 409) {
			const result = (await res.json()) as MemoryReviewResult;
			throw new MemoryReviewRequiredError(result);
		}
		if (!res.ok) throw new Error("Failed to create memory");
		return res.json();
	},

	async reviewInbox(): Promise<MemoryReviewInboxResponse> {
		const res = await apiFetch(`${API_BASE}/api/memories/review`);
		if (!res.ok) throw new Error("Failed to fetch memory review inbox");
		return res.json();
	},

	async resolveReview(data: MemoryResolveRequest): Promise<MemoryReviewResult> {
		const res = await apiFetch(`${API_BASE}/api/memories/review/resolve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!res.ok) {
			const error = await res.json().catch(() => ({ error: "Failed to resolve memory review" }));
			throw new Error(error.error || "Failed to resolve memory review");
		}
		return res.json();
	},

	async update(id: string, data: Partial<MemoryEntry>): Promise<MemoryEntry> {
		const res = await apiFetch(`${API_BASE}/api/memories/${encodeURIComponent(id)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!res.ok) throw new Error(`Failed to update memory ${id}`);
		return res.json();
	},

	async action(id: string, data: MemoryActionRequest): Promise<MemoryEntry> {
		const res = await apiFetch(`${API_BASE}/api/memories/${encodeURIComponent(id)}/action`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!res.ok) {
			const error = await res.json().catch(() => ({ error: `Failed to update memory ${id}` }));
			throw new Error(error.error || `Failed to update memory ${id}`);
		}
		return res.json();
	},

	async bulkAction(action: MemoryBulkAction, ids: string[], rejectedReason?: string): Promise<{ updated: MemoryEntry[]; count: number }> {
		const res = await apiFetch(`${API_BASE}/api/memories/bulk`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action, ids, rejectedReason }),
		});
		if (!res.ok) {
			const error = await res.json().catch(() => ({ error: "Failed to update memories" }));
			throw new Error(error.error || "Failed to update memories");
		}
		return res.json();
	},

	async delete(id: string): Promise<void> {
		const res = await apiFetch(`${API_BASE}/api/memories/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
		if (!res.ok) throw new Error(`Failed to delete memory ${id}`);
	},

	async promote(id: string): Promise<MemoryEntry> {
		const res = await apiFetch(`${API_BASE}/api/memories/${encodeURIComponent(id)}/promote`, {
			method: "POST",
		});
		if (!res.ok) throw new Error(`Failed to promote memory ${id}`);
		return res.json();
	},

	async demote(id: string): Promise<MemoryEntry> {
		const res = await apiFetch(`${API_BASE}/api/memories/${encodeURIComponent(id)}/demote`, {
			method: "POST",
		});
		if (!res.ok) throw new Error(`Failed to demote memory ${id}`);
		return res.json();
	},
};

export const workingMemoryApi = {
	async list(): Promise<MemoryEntry[]> {
		const res = await apiFetch(`${API_BASE}/api/working-memories`);
		if (!res.ok) throw new Error("Failed to fetch working memory");
		return res.json();
	},

	async get(id: string): Promise<MemoryEntry> {
		const res = await apiFetch(`${API_BASE}/api/working-memories/${encodeURIComponent(id)}`);
		if (!res.ok) throw new Error(`Failed to fetch working memory ${id}`);
		return res.json();
	},

	async create(data: Partial<MemoryEntry>): Promise<MemoryEntry> {
		const res = await apiFetch(`${API_BASE}/api/working-memories`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!res.ok) throw new Error("Failed to create working memory");
		return res.json();
	},

	async delete(id: string): Promise<void> {
		const res = await apiFetch(`${API_BASE}/api/working-memories/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
		if (!res.ok) throw new Error(`Failed to delete working memory ${id}`);
	},

	async clean(): Promise<{ cleaned: number }> {
		const res = await apiFetch(`${API_BASE}/api/working-memories/clean`, {
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

		const res = await apiFetch(`${API_BASE}/api/audit/recent?${params.toString()}`);
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

		const res = await apiFetch(`${API_BASE}/api/audit/stats?${params.toString()}`);
		if (!res.ok) throw new Error("Failed to fetch audit stats");
		return res.json();
	},
};

// Auth API
export const authApi = {
	async getStatus(): Promise<{ protected: boolean; authenticated: boolean }> {
		const res = await apiFetch(`${API_BASE}/api/auth/status`);
		if (!res.ok) throw new Error("Failed to fetch auth status");
		return res.json();
	},

	async login(password: string): Promise<{ success: boolean }> {
		const res = await apiFetch(`${API_BASE}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password }),
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || "Login failed");
		}
		return res.json();
	},

	async setPassword(password: string): Promise<{ success: boolean; token?: string }> {
		const res = await apiFetch(`${API_BASE}/api/auth/password`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password }),
		});
		if (!res.ok) throw new Error("Failed to set password");
		return res.json();
	},

	async removePassword(): Promise<void> {
		const res = await apiFetch(`${API_BASE}/api/auth/password`, {
			method: "DELETE",
		});
		if (!res.ok) throw new Error("Failed to remove password");
	},
};

// Tunnel API
export const tunnelApi = {
	async getStatus(): Promise<{ running: boolean; url?: string; pid?: number; startedByUs?: boolean }> {
		const res = await apiFetch(`${API_BASE}/api/tunnel/status`);
		if (!res.ok) throw new Error("Failed to fetch tunnel status");
		return res.json();
	},

	async start(): Promise<{ url: string; status: string }> {
		const res = await apiFetch(`${API_BASE}/api/tunnel/start`, {
			method: "POST",
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || "Failed to start tunnel");
		}
		return res.json();
	},

	async stop(): Promise<void> {
		const res = await apiFetch(`${API_BASE}/api/tunnel/stop`, {
			method: "POST",
		});
		if (!res.ok) throw new Error("Failed to stop tunnel");
	},
};
