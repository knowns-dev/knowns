import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { getConfig, patchConfig } from "../api/client";
import type { OpenCodeModelSettings } from "../models/chat";
import {
	DEFAULT_TASK_LIFECYCLE_SETTINGS,
	type TaskLifecycleSettings,
} from "../models/taskLifecycle";

// Import config type
interface ImportConfig {
	name: string;
	source: string;
	type: "git" | "npm" | "local" | "registry";
	ref?: string;
	version?: string;
	include?: string[];
	exclude?: string[];
	autoSync?: boolean;
	link?: boolean;
}

// Config interface (matches ConfigPage.tsx)
export interface Config {
	name?: string;
	id?: string;
	createdAt?: string;
	serverPort?: number;
	imports?: ImportConfig[];
	defaultAssignee?: string;
	defaultPriority?: "low" | "medium" | "high";
	defaultLabels?: string[];
	timeFormat?: "12h" | "24h";
	editor?: string;
	visibleColumns?: string[];
	statuses?: string[];
	statusColors?: Record<string, string>;
	phaseAgentDefaults?: Record<string, string>;
	opencodeServer?: {
		host?: string;
		port?: number;
		password?: string;
	};
	opencodeModels?: OpenCodeModelSettings;
	platforms?: string[];
	enableChatUI?: boolean;
	opencodeInstalled?: boolean;
	semanticSearch?: {
		enabled?: boolean;
		model?: string;
		provider?: string;
		huggingFaceId?: string;
		dimensions?: number;
		maxTokens?: number;
	};
	lsp?: {
		enabled?: boolean;
		languages?: Record<string, {
			enabled?: boolean;
			binary?: string;
			version?: string;
			backend?: string;
			projectPath?: string;
			settings?: Record<string, any>;
		}>;
	};
	codeIntelligenceIgnore?: string[];
	gitTrackingMode?: string;
	runtimeMemory?: {
		mode?: string;
		maxItems?: number;
		maxBytes?: number;
	};
	taskLifecycle?: TaskLifecycleSettings;
	capabilities?: {
		taskHardDelete?: boolean;
	};
}

export type ConfigPatch = Omit<Partial<Config>, "taskLifecycle"> & {
	taskLifecycle?: Partial<TaskLifecycleSettings>;
};

interface ConfigContextType {
	config: Config;
	loading: boolean;
	error: Error | null;
	updateConfig: (updates: ConfigPatch) => Promise<void>;
	refetch: () => Promise<void>;
	/** True when the "opencode" platform is enabled (or platforms is unset = all enabled). */
	chatUIEnabled: boolean;
}

const ConfigContext = createContext<ConfigContextType | undefined>(undefined);

// Default config values
const DEFAULT_CONFIG: Config = {
	name: "Knowns",
	defaultPriority: "medium",
	defaultLabels: [],
	statuses: ["todo", "in-progress", "in-review", "done", "blocked", "on-hold", "urgent"],
	visibleColumns: ["todo", "in-progress", "in-review", "done", "blocked"],
	statusColors: {},
	taskLifecycle: DEFAULT_TASK_LIFECYCLE_SETTINGS,
};

function editablePatch(updates: ConfigPatch): ConfigPatch {
	const {
		capabilities: _readOnlyCapabilities,
		id: _readOnlyID,
		createdAt: _readOnlyCreatedAt,
		opencodeInstalled: _readOnlyOpenCodeInstalled,
		...patch
	} = updates;
	return patch;
}

function mergeConfig(base: Config, patch: ConfigPatch): Config {
	const { taskLifecycle, ...flatPatch } = patch;
	return {
		...base,
		...flatPatch,
		...(taskLifecycle
			? { taskLifecycle: { ...(base.taskLifecycle || DEFAULT_TASK_LIFECYCLE_SETTINGS), ...taskLifecycle } }
			: {}),
	};
}

function effectiveServerConfig(data: Config): Config {
	return {
		...DEFAULT_CONFIG,
		...data,
		taskLifecycle: {
			...DEFAULT_TASK_LIFECYCLE_SETTINGS,
			...(data.taskLifecycle || {}),
		},
		capabilities: data.capabilities ? { ...data.capabilities } : undefined,
	};
}

export function ConfigProvider({ children }: { children: ReactNode }) {
	const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<Error | null>(null);

	const pendingRef = useRef<Array<{ id: number; patch: ConfigPatch }>>([]);
	const nextPatchIDRef = useRef(0);
	const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
	const fetchGenerationRef = useRef(0);

	const applyEffective = useCallback((data: Config) => {
		const withPending = pendingRef.current.reduce(
			(current, pending) => mergeConfig(current, pending.patch),
			effectiveServerConfig(data),
		);
		setConfig(withPending);
	}, []);

	const fetchConfig = useCallback(async () => {
		const generation = ++fetchGenerationRef.current;
		try {
			setLoading(true);
			setError(null);
			const data = (await getConfig()) as Config;
			if (generation === fetchGenerationRef.current) applyEffective(data);
		} catch (err) {
			if (generation === fetchGenerationRef.current) {
				setError(err instanceof Error ? err : new Error("Failed to fetch config"));
				setConfig(DEFAULT_CONFIG);
			}
		} finally {
			if (generation === fetchGenerationRef.current) setLoading(false);
		}
	}, [applyEffective]);

	useEffect(() => {
		fetchConfig();
	}, [fetchConfig]);

	const updateConfig = useCallback(async (updates: ConfigPatch) => {
		const patch = editablePatch(updates);
		if (Object.keys(patch).length === 0) return;
		const id = ++nextPatchIDRef.current;
		pendingRef.current.push({ id, patch });
		setConfig((current) => mergeConfig(current, patch));

		const operation = saveQueueRef.current.then(async () => {
			try {
				const effective = (await patchConfig(patch as Record<string, unknown>)) as Config;
				pendingRef.current = pendingRef.current.filter((entry) => entry.id !== id);
				++fetchGenerationRef.current;
				applyEffective(effective);
			} catch (err) {
				pendingRef.current = pendingRef.current.filter((entry) => entry.id !== id);
				const generation = ++fetchGenerationRef.current;
				try {
					const effective = (await getConfig()) as Config;
					if (generation === fetchGenerationRef.current) applyEffective(effective);
				} catch {
					// Preserve the last effective state if rollback refetch is unavailable.
				}
				throw err;
			}
		});
		saveQueueRef.current = operation.catch(() => {});
		return operation;
	}, [applyEffective]);

	return (
		<ConfigContext.Provider
			value={{
				config,
				loading,
				error,
				updateConfig,
				refetch: fetchConfig,
				chatUIEnabled: config.enableChatUI !== false && config.opencodeInstalled !== false,
			}}
		>
			{children}
		</ConfigContext.Provider>
	);
}

export function useConfig() {
	const context = useContext(ConfigContext);
	if (context === undefined) {
		throw new Error("useConfig must be used within a ConfigProvider");
	}
	return context;
}
