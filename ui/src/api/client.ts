import type { Task, TimeEntry } from "@/ui/models/task";
import type { TaskChange, TaskVersion, TaskHistoryMetadata } from "@/ui/models/version";
import { getTaskLifecycleState } from "@/ui/models/taskLifecycle";
import type {
	TaskLifecycleEvent,
	TaskLifecycleReason,
	TaskLifecycleRequest,
	TaskLifecycleResponse,
	TaskLifecycleResult,
} from "@/ui/models/taskLifecycle";

// Use env vars from Vite, fallback to relative paths for production
export const API_BASE = import.meta.env.API_URL || "";

// Wrapper that always sends credentials (cookies) with requests. Exported so
// components never hand-roll a relative fetch: in dev the UI is served by Vite
// on a different port with no /api proxy, so a relative URL silently returns
// index.html instead of JSON.
export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
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
	completedAt?: string;
	archivedAt?: string;
	archived: boolean;
	lifecycleState: Task["lifecycleState"];
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

export type CreateTaskInput = Partial<Task> & {
	prefix?: string;
};

interface TaskVersionDTO {
	id: string;
	taskId: string;
	version: number;
	timestamp: string;
	author?: string;
	changes: TaskChange[];
	snapshot: Partial<TaskDTO>;
}

interface HistoryMetadataDTO {
	id: string;
	entityId: string;
	revision: number;
	legacyRevision?: number;
	timestamp: string;
	author?: string;
	actor?: string;
	source?: string;
	baseHash?: string;
	newHash?: string;
	checkpoint?: boolean;
	operation?: string;
	tombstone?: boolean;
	currentPath?: string;
	previousPath?: string;
}

export interface TaskHistoryMetadataPage {
	offset: number;
	limit: number;
	hasMore: boolean;
	nextOffset?: number;
	currentVersion: number;
	tailTruncated?: boolean;
	items: TaskHistoryMetadata[];
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

function parseHistoryMetadata(dto: HistoryMetadataDTO): TaskHistoryMetadata {
	return {
		id: dto.id,
		taskId: dto.entityId,
		version: dto.legacyRevision || dto.revision,
		timestamp: new Date(dto.timestamp),
		author: dto.author,
		actor: dto.actor,
		source: dto.source,
		baseHash: dto.baseHash,
		newHash: dto.newHash,
		checkpoint: dto.checkpoint,
		operation: dto.operation,
		tombstone: dto.tombstone,
		currentPath: dto.currentPath,
		previousPath: dto.previousPath,
	};
}

function parseActivityDTO(dto: ActivityDTO): Activity {
	return {
		...dto,
		timestamp: new Date(dto.timestamp),
	};
}

function parseTaskDTO(dto: TaskDTO): Task {
	const lifecycleState = getTaskLifecycleState(dto);
	return {
		...dto,
		status: dto.status as Task["status"],
		priority: dto.priority as Task["priority"],
		subtasks: dto.subtasks || [],
		labels: dto.labels || [],
		acceptanceCriteria: dto.acceptanceCriteria || [],
		createdAt: new Date(dto.createdAt),
		updatedAt: new Date(dto.updatedAt),
		completedAt: dto.completedAt ? new Date(dto.completedAt) : undefined,
		archivedAt: dto.archivedAt ? new Date(dto.archivedAt) : undefined,
		archived: dto.archived ?? lifecycleState === "archived",
		lifecycleState,
		timeEntries: (dto.timeEntries || []).map((entry) => ({
			...entry,
			startedAt: new Date(entry.startedAt),
			endedAt: entry.endedAt ? new Date(entry.endedAt) : undefined,
		})),
	};
}

interface TaskLifecycleReasonDTO extends Omit<TaskLifecycleReason, "deadline"> {
	deadline?: string;
}

interface TaskLifecycleEventDTO extends Omit<TaskLifecycleEvent, "at"> {
	at: string;
}

interface TaskLifecycleResultDTO extends Omit<TaskLifecycleResult, "reasons" | "event" | "completedAt" | "archivedAt" | "deadline"> {
	reasons: TaskLifecycleReasonDTO[];
	event?: TaskLifecycleEventDTO;
	completedAt?: string;
	archivedAt?: string;
	deadline?: string;
}

interface TaskLifecycleResponseDTO extends Omit<TaskLifecycleResponse, "items"> {
	items: TaskLifecycleResultDTO[];
}

function parseLifecycleResponse(dto: TaskLifecycleResponseDTO): TaskLifecycleResponse {
	return {
		...dto,
		items: (dto.items || []).map((item) => ({
			...item,
			reasons: (item.reasons || []).map((reason) => ({
				...reason,
				deadline: reason.deadline ? new Date(reason.deadline) : undefined,
			})),
			event: item.event ? { ...item.event, at: new Date(item.event.at) } : undefined,
			completedAt: item.completedAt ? new Date(item.completedAt) : undefined,
			archivedAt: item.archivedAt ? new Date(item.archivedAt) : undefined,
			deadline: item.deadline ? new Date(item.deadline) : undefined,
		})),
	};
}

export class LifecycleAPIError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly response?: TaskLifecycleResponse,
	) {
		super(message);
		this.name = "LifecycleAPIError";
	}
}

async function lifecycleFetch(
	path: string,
	request: Omit<TaskLifecycleRequest, "operation">,
	signal?: AbortSignal,
): Promise<TaskLifecycleResponse> {
	const res = await apiFetch(`${API_BASE}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(request),
		signal,
	});
	let response: TaskLifecycleResponse | undefined;
	try {
		response = parseLifecycleResponse((await res.json()) as TaskLifecycleResponseDTO);
	} catch {
		// Preserve the HTTP failure even if an intermediary returned non-contract JSON.
	}
	if (!res.ok) {
		const reason = response?.items.flatMap((item) => item.reasons)[0];
		throw new LifecycleAPIError(reason?.message || `Lifecycle request failed (${res.status})`, res.status, response);
	}
	if (!response) throw new LifecycleAPIError("Lifecycle response was invalid", res.status);
	return response;
}

export const api = {
	async getTasks(options?: { includeHistorical?: boolean; signal?: AbortSignal }): Promise<Task[]> {
		const params = new URLSearchParams();
		if (options?.includeHistorical) params.set("includeHistorical", "true");
		const query = params.size ? `?${params.toString()}` : "";
		const res = await apiFetch(`${API_BASE}/api/tasks${query}`, { signal: options?.signal });
		if (!res.ok) {
			throw new Error("Failed to fetch tasks");
		}
		const data = (await res.json()) as TaskDTO[];
		return data.map(parseTaskDTO);
	},

	async getTask(id: string, options?: { signal?: AbortSignal }): Promise<Task> {
		const res = await apiFetch(`${API_BASE}/api/tasks/${id}`, { signal: options?.signal });
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

	async createTask(data: CreateTaskInput): Promise<Task> {
		const res = await apiFetch(`${API_BASE}/api/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Failed to create task: ${text}`);
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

	async getTaskHistoryMetadata(id: string, offset = 0, limit = 50): Promise<TaskHistoryMetadataPage> {
		const res = await apiFetch(`${API_BASE}/api/tasks/${id}/history?metadata=true&offset=${offset}&limit=${limit}`);
		if (!res.ok) throw new Error(`Failed to fetch history metadata for task ${id}`);
		const data = (await res.json()) as { offset: number; limit: number; hasMore: boolean; nextOffset?: number; currentVersion: number; items: HistoryMetadataDTO[] };
		return { ...data, items: (data.items || []).map(parseHistoryMetadata) };
	},

	async getTaskRevisionDetail(id: string, revision: string | number): Promise<TaskVersion> {
		const res = await apiFetch(`${API_BASE}/api/tasks/${id}/history/${encodeURIComponent(String(revision))}`);
		if (!res.ok) throw new Error(`Failed to fetch revision ${revision} for task ${id}`);
		return parseVersionDTO((await res.json()) as TaskVersionDTO);
	},

	async archiveTask(id: string, execute = false, signal?: AbortSignal): Promise<TaskLifecycleResponse> {
		return lifecycleFetch(`/api/tasks/${encodeURIComponent(id)}/archive`, { taskId: id, execute }, signal);
	},

	async unarchiveTask(id: string, execute = false, status?: string, signal?: AbortSignal): Promise<TaskLifecycleResponse> {
		return lifecycleFetch(`/api/tasks/${encodeURIComponent(id)}/unarchive`, { taskId: id, execute, status }, signal);
	},

	async batchArchiveTasks(request: { ids?: string[]; execute?: boolean; minimumAgeMs?: number } = {}): Promise<TaskLifecycleResponse> {
		return lifecycleFetch("/api/tasks/batch-archive", { ...request, execute: request.execute ?? false });
	},

	async batchUnarchiveTasks(ids: string[], execute = false, status?: string): Promise<TaskLifecycleResponse> {
		return lifecycleFetch("/api/tasks/batch-unarchive", { ids, execute, status });
	},

	async hardDeleteTask(id: string, reason: string, confirmed: boolean): Promise<TaskLifecycleResponse> {
		return lifecycleFetch(`/api/tasks/${encodeURIComponent(id)}/hard-delete`, {
			taskId: id,
			execute: confirmed,
			confirmed,
			reason,
		});
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
	batchUnarchiveTasks,
	hardDeleteTask,
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
	capabilitiesKnown?: boolean;
	capabilities?: string[];
	advertisedCapabilities?: string[];
	observedCapabilities?: string[];
	requiredCapabilities?: string[];
	missingCapabilities?: string[];
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

export async function patchConfig(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
	const res = await apiFetch(`${API_BASE}/api/config`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(patch),
	});
	if (!res.ok) {
		let message = "Failed to save config";
		try {
			const body = (await res.json()) as { error?: string };
			if (body.error) message = body.error;
		} catch {
			// Keep the stable fallback when a proxy returns a non-JSON error.
		}
		throw new Error(message);
	}
	const data = await res.json();
	return data.config || {};
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

export interface DocChange {
	field: string;
	oldValue?: unknown;
	newValue?: unknown;
}

export interface DocChangeScope {
	type: string;
	field?: string;
	section?: string;
	summary?: string;
	oldBytes?: number;
	newBytes?: number;
	deltaBytes?: number;
}

export interface DocHistoryGap {
	type: string;
	reason: string;
	count: number;
	beforeVersion?: string;
	afterVersion?: string;
	appliedAt: string;
}

export interface DocVersion {
	id: string;
	docId?: string;
	docPath: string;
	currentPath?: string;
	previousPath?: string;
	version: number;
	timestamp: string;
	author?: string;
	actor?: string;
	source?: string;
	auditEventId?: string;
	sessionId?: string;
	baseHash?: string;
	newHash?: string;
	checkpoint?: boolean;
	operation?: string;
	tombstone?: boolean;
	changes: DocChange[];
	changedScopes?: DocChangeScope[];
	snapshot?: Record<string, unknown>;
}

export interface DocHistoryMetadata {
	id: string;
	docId?: string;
	docPath?: string;
	currentPath?: string;
	previousPath?: string;
	version: number;
	timestamp: string;
	author?: string;
	actor?: string;
	source?: string;
	baseHash?: string;
	newHash?: string;
	checkpoint?: boolean;
	operation?: string;
	tombstone?: boolean;
}

export interface DocHistoryMetadataPage {
	offset: number;
	limit: number;
	hasMore: boolean;
	nextOffset?: number;
	currentVersion: number;
	entityId?: string;
	docPath?: string;
	currentPath?: string;
	retentionGaps?: DocHistoryGap[];
	tailTruncated?: boolean;
	items: DocHistoryMetadata[];
}

export interface DocVersionHistory {
	docId?: string;
	docPath: string;
	currentPath?: string;
	currentVersion: number;
	versions: DocVersion[];
	retentionGaps?: DocHistoryGap[];
	tailTruncated?: boolean;
}

export interface DocRevisionDiff {
	docId?: string;
	docPath: string;
	currentPath?: string;
	revisionId: string;
	previousRevisionId?: string;
	version: DocVersion;
	checkpoint: boolean;
	changes: DocChange[];
	changedScopes?: DocChangeScope[];
	retentionGaps?: DocHistoryGap[];
}

export interface RestoreDocRevisionResponse {
	restored: boolean;
	doc: Doc;
	history: DocVersionHistory;
}

function encodeDocPath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
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
	const encodedPath = encodeDocPath(path);
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
	const encodedPath = encodeDocPath(path);
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

export async function getDocHistory(path: string): Promise<DocVersionHistory> {
	const encodedPath = encodeDocPath(path);
	const res = await apiFetch(`${API_BASE}/api/docs/${encodedPath}/history`);
	if (!res.ok) {
		throw new Error(`Failed to fetch doc history for ${path}`);
	}
	return res.json();
}

export async function getDocHistoryMetadata(path: string, offset = 0, limit = 50): Promise<DocHistoryMetadataPage> {
	const encodedPath = encodeDocPath(path);
	const res = await apiFetch(`${API_BASE}/api/docs/${encodedPath}/history?metadata=true&offset=${offset}&limit=${limit}`);
	if (!res.ok) throw new Error(`Failed to fetch doc history metadata for ${path}`);
	const data = (await res.json()) as Omit<DocHistoryMetadataPage, "items"> & { items: HistoryMetadataDTO[] };
	return {
		...data,
		items: (data.items || []).map((item) => ({
			id: item.id,
			docId: item.entityId,
			docPath: item.currentPath || data.docPath,
			currentPath: item.currentPath,
			previousPath: item.previousPath,
			version: item.legacyRevision || item.revision,
			timestamp: item.timestamp,
			author: item.author,
			actor: item.actor,
			source: item.source,
			baseHash: item.baseHash,
			newHash: item.newHash,
			checkpoint: item.checkpoint,
			operation: item.operation,
			tombstone: item.tombstone,
		})),
	};
}

export async function getDocRevisionDetail(path: string, revisionId: string): Promise<DocVersion> {
	const encodedPath = encodeDocPath(path);
	const encodedRevision = encodeURIComponent(revisionId);
	const res = await apiFetch(`${API_BASE}/api/docs/${encodedPath}/history/${encodedRevision}`);
	if (!res.ok) throw new Error(`Failed to fetch doc revision ${revisionId}`);
	return res.json();
}

export async function getDocRevisionDiff(path: string, revisionId: string): Promise<DocRevisionDiff> {
	const encodedPath = encodeDocPath(path);
	const encodedRevision = encodeURIComponent(revisionId);
	const res = await apiFetch(`${API_BASE}/api/docs/${encodedPath}/history/${encodedRevision}/diff`);
	if (!res.ok) {
		throw new Error(`Failed to fetch doc revision ${revisionId}`);
	}
	return res.json();
}

export async function restoreDocRevision(
	path: string,
	data: { revisionId: string; mode?: "document" | "section"; section?: string },
): Promise<RestoreDocRevisionResponse> {
	const encodedPath = encodeDocPath(path);
	const res = await apiFetch(`${API_BASE}/api/docs/${encodedPath}/restore`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(data),
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({ error: "Failed to restore doc revision" }));
		throw new Error(error.error || "Failed to restore doc revision");
	}
	return res.json();
}

export interface KnownsSearchResult {
	type: "task" | "doc" | "memory" | "decision" | "code";
	id: string;
	title: string;
	score: number;
	snippet?: string;
	status?: string;
	priority?: string;
	path?: string;
	tags?: string[];
	memoryLayer?: string;
	category?: string;
}

export interface KnownsSearchResponse {
	tasks: Array<Task & { score?: number; snippet?: string; matchedBy?: string[] }>;
	docs: KnownsSearchResult[];
	memories: KnownsSearchResult[];
	decisions: KnownsSearchResult[];
	code: KnownsSearchResult[];
}

export interface KnownsSearchOptions {
	type?: "all" | "task" | "doc" | "memory" | "decision" | "code";
	mode?: "keyword" | "semantic" | "hybrid";
	limit?: number;
	includeHistorical?: boolean;
}

// Search API
export async function search(
	query: string,
	options: KnownsSearchOptions = {},
): Promise<KnownsSearchResponse> {
	const params = new URLSearchParams({ q: query });
	if (options.type) params.set("type", options.type);
	if (options.mode) params.set("mode", options.mode);
	if (options.limit) params.set("limit", String(options.limit));
	if (options.includeHistorical) params.set("includeHistorical", "true");
	const res = await apiFetch(`${API_BASE}/api/search?${params.toString()}`);
	if (!res.ok) {
		throw new Error("Failed to search");
	}
	const data = await res.json();
	return {
		tasks: (data.tasks || []).map(parseTaskDTO),
		docs: data.docs || [],
		memories: data.memories || [],
		decisions: data.decisions || [],
		code: data.code || [],
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
	// A spec's linked tasks are the evidence of who implemented it, so archived
	// implementers stay in the list. The panel marks them instead of hiding them:
	// dropping them would make a fully implemented spec look unimplemented.
	const tasks = await api.getTasks({ includeHistorical: true });
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

export async function getGraph(options?: { includeHistorical?: boolean }): Promise<GraphData> {
	const params = new URLSearchParams();
	if (options?.includeHistorical) params.set("includeHistorical", "true");
	const query = params.toString();
	const res = await apiFetch(`${API_BASE}/api/graph${query ? `?${query}` : ""}`);
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
export type DecisionReviewState = "needs_evidence" | "needs_resolution" | "ready_for_review";
export type DecisionReviewResolution =
	| "accept_new"
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
	verification?: string[];
	verifiedAt?: string;
	reviewState?: DecisionReviewState;
	reviewBlockers?: string[];
	reviewMatches?: DecisionReviewMatch[];
	reviewAllowedResolutions?: DecisionReviewResolution[];
	reviewEvaluatedAt?: string;
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

export interface DecisionAcceptResult extends DecisionReviewResult {
	decision: DecisionEntry;
}

export interface DecisionResolveRequest extends Partial<DecisionEntry> {
	resolution: DecisionReviewResolution;
	candidateId?: string;
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

	async reviewInbox(): Promise<DecisionEntry[]> {
		const res = await apiFetch(`${API_BASE}/api/decisions/review/inbox`);
		if (!res.ok) throw new Error("Failed to fetch Decision review inbox");
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

	async link(
		id: string,
		data: { sources?: string[]; relatedDocs?: string[]; relatedTasks?: string[] },
	): Promise<DecisionEntry> {
		const res = await apiFetch(`${API_BASE}/api/decisions/${encodeURIComponent(id)}/link`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!res.ok) {
			const error = await res.json().catch(() => ({ error: `Failed to link decision ${id}` }));
			throw new Error(error.error || `Failed to link decision ${id}`);
		}
		return res.json();
	},

	async accept(id: string, supersedes: string[] = []): Promise<DecisionAcceptResult> {
		const res = await apiFetch(`${API_BASE}/api/decisions/${encodeURIComponent(id)}/accept`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ supersedes }),
		});
		if (!res.ok) {
			const error = await res.json().catch(() => ({ error: `Failed to accept decision ${id}` }));
			throw new Error(error.error || `Failed to accept decision ${id}`);
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

export type DecisionMigrationResolution =
	| "create_decision"
	| "link_existing"
	| "consolidate_duplicate"
	| "reclassify"
	| "archive_noise"
	| "reject_noise"
	| "leave_unchanged";

export interface DecisionMigrationCandidate {
	memoryId: string;
	title: string;
	layer: "project" | "global";
	status: string;
	sources: string[];
	sourceIssues?: string[];
	noiseLikelihood: "low" | "medium" | "high";
	noiseReasons?: string[];
	duplicateGroup?: string;
	duplicateMembers?: string[];
	proposedResolution: DecisionMigrationResolution;
	proposedDecisionId?: string;
	proposedTargetId?: string;
	proposedCategory?: string;
	journalState?: "pending" | "applied" | "rolled_back" | "failed";
	linkedDecisionId?: string;
}

export interface DecisionMigrationPreview {
	candidates: DecisionMigrationCandidate[];
	counts: { total: number; highNoise: number; duplicate: number; withIssue: number };
}

export interface DecisionMigrationSelection {
	memoryId: string;
	resolution: DecisionMigrationResolution;
	decisionId?: string;
	targetMemoryId?: string;
	category?: string;
	reason?: string;
	relatedDocs?: string[];
	relatedTasks?: string[];
	acceptVerified?: boolean;
}

export interface DecisionMigrationItemResult {
	memoryId: string;
	resolution: DecisionMigrationResolution;
	state: string;
	decisionId?: string;
	legacyExcluded: boolean;
	idempotent?: boolean;
	error?: string;
}

export interface DecisionMigrationApplyResult {
	results: DecisionMigrationItemResult[];
}

export const decisionMigrationApi = {
	async preview(): Promise<DecisionMigrationPreview> {
		const res = await apiFetch(`${API_BASE}/api/decisions/migration/preview`);
		if (!res.ok) {
			const error = await res.json().catch(() => ({ error: "Failed to preview Decision Memory migration" }));
			throw new Error(error.error || "Failed to preview Decision Memory migration");
		}
		return res.json();
	},

	async apply(selection: DecisionMigrationSelection): Promise<DecisionMigrationApplyResult> {
		const res = await apiFetch(`${API_BASE}/api/decisions/migration/apply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ selections: [selection] }),
		});
		const payload = await res.json().catch(() => ({}));
		if (!res.ok) {
			throw new Error(payload.error || "Failed to apply Decision Memory migration");
		}
		return payload as DecisionMigrationApplyResult;
	},

	async rollback(memoryId: string): Promise<{ memoryId: string; state: string; decisionId?: string }> {
		const res = await apiFetch(`${API_BASE}/api/decisions/migration/${encodeURIComponent(memoryId)}/rollback`, {
			method: "POST",
		});
		const payload = await res.json().catch(() => ({}));
		if (!res.ok) {
			throw new Error(payload.error || `Failed to roll back migration for ${memoryId}`);
		}
		return payload;
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
		if (!res.ok) {
			const error = await res.json().catch(() => ({ error: "Failed to create memory" }));
			throw new Error(error.error || "Failed to create memory");
		}
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
		if (!res.ok) {
			const error = await res.json().catch(() => ({ error: `Failed to update memory ${id}` }));
			throw new Error(error.error || `Failed to update memory ${id}`);
		}
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

export type AuditRangeDays = 7 | 30 | 90;

export interface AuditCoverage {
	startDate?: string;
	endDate?: string;
	partial: boolean;
}

export interface AuditDailyBucket {
	date: string;
	covered: boolean;
	totalCalls: number;
	successCount: number;
	errorCount: number;
	deniedCount: number;
	needsAttention: number;
	averageDurationMs: number;
	topTool?: string;
	topToolCalls: number;
}

export interface AuditToolStats {
	tool: string;
	totalCalls: number;
	byResult: Record<string, number>;
	averageDurationMs: number;
}

export interface AuditAnalytics extends AuditStats {
	timezone: string;
	rangeStart: string;
	rangeEnd: string;
	coverage: AuditCoverage;
	dailyBuckets: AuditDailyBucket[];
	tools: AuditToolStats[];
	byProject: Record<string, number>;
	needsAttention: number;
	averageDurationMs: number;
}

export const auditApi = {
	async recent(options?: {
		limit?: number;
		tool?: string;
		result?: string;
		project?: string;
		/** Inclusive calendar day (YYYY-MM-DD) in the caller's timezone. */
		from?: string;
		to?: string;
		timezone?: string;
	}): Promise<{ events: AuditEvent[]; count: number }> {
		const params = new URLSearchParams();
		if (options?.limit) params.set("limit", String(options.limit));
		if (options?.tool) params.set("tool", options.tool);
		if (options?.result) params.set("result", options.result);
		if (options?.project) params.set("project", options.project);
		if (options?.from) params.set("from", options.from);
		if (options?.to) params.set("to", options.to);
		if (options?.timezone) params.set("timezone", options.timezone);

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

	async analytics(options: {
		days: AuditRangeDays;
		timezone: string;
		project?: string;
		scope?: "project" | "all";
	}): Promise<AuditAnalytics> {
		const params = new URLSearchParams();
		params.set("days", String(options.days));
		params.set("timezone", options.timezone);
		params.set("scope", options.scope ?? (options.project ? "project" : "all"));
		if (options.project) params.set("project", options.project);

		const res = await apiFetch(`${API_BASE}/api/audit/analytics?${params.toString()}`);
		if (!res.ok) throw new Error("Failed to fetch audit analytics");
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
