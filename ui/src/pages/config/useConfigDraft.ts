import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/ui/components/ui/sonner";
import { useConfig, type Config, type ConfigPatch } from "@/ui/contexts/ConfigContext";

export const DEFAULT_STATUSES = ["todo", "in-progress", "in-review", "done", "blocked", "on-hold", "urgent"];

function mergeConfigPatch(base: ConfigPatch, patch: ConfigPatch): ConfigPatch {
	return {
		...base,
		...patch,
		...(base.taskLifecycle || patch.taskLifecycle
			? { taskLifecycle: { ...(base.taskLifecycle || {}), ...(patch.taskLifecycle || {}) } }
			: {}),
	};
}

function applyConfigPatch(base: Config, patch: ConfigPatch): Config {
	const { taskLifecycle, ...flatPatch } = patch;
	return {
		...base,
		...flatPatch,
		...(taskLifecycle
			? { taskLifecycle: { ...(base.taskLifecycle || {}), ...taskLifecycle } as NonNullable<Config["taskLifecycle"]> }
			: {}),
	};
}

/** Debounced PATCH /api/config: patches inside the window merge into one request. */
function useAutoSave(updateConfig: (c: ConfigPatch) => Promise<void>) {
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pendingPatchRef = useRef<ConfigPatch>({});

	const save = useCallback(
		(patch: ConfigPatch) => {
			pendingPatchRef.current = mergeConfigPatch(pendingPatchRef.current, patch);
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(async () => {
				const patchToSave = pendingPatchRef.current;
				pendingPatchRef.current = {};
				try {
					await updateConfig(patchToSave);
					toast.success("Saved", { duration: 1500, position: "bottom-right" });
				} catch (error) {
					toast.error(error instanceof Error ? error.message : "Failed to save settings", { position: "bottom-right" });
				}
			}, 600);
		},
		[updateConfig],
	);

	useEffect(() => {
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, []);

	return save;
}

/** Server-owned fields the PATCH endpoint must never receive back. */
export function editableConfig(config: Config): Config {
	const {
		capabilities: _readOnlyCapabilities,
		id: _readOnlyID,
		createdAt: _readOnlyCreatedAt,
		...editable
	} = config;
	return editable;
}

/**
 * Ollama is the only local/default embedding provider; "api" is the only alternative. Anything else
 * (including a stale "local" value from an unmigrated config) falls back to "ollama" rather than
 * leaving the provider selector on an option that no longer exists.
 */
export function effectiveSemanticProvider(config: Config): string {
	return config.semanticSearch?.provider === "api" ? "api" : "ollama";
}

export interface ConfigDraft {
	config: Config;
	loading: boolean;
	initialized: boolean;
	/** Applies the patch to the local draft and autosaves it. */
	update: (patch: ConfigPatch) => void;
	/** Autosaves a patch without touching the draft (the caller already set it). */
	autoSave: (patch: ConfigPatch) => void;
	setConfig: React.Dispatch<React.SetStateAction<Config>>;
	/** Immediate save, for the raw JSON editor. */
	updateConfig: (patch: ConfigPatch) => Promise<void>;
}

/**
 * The local draft of the project config. It follows the latest effective server config; a validation
 * failure triggers a GET rollback in ConfigContext, which flows back in here.
 */
export function useConfigDraft(): ConfigDraft {
	const { config: globalConfig, loading, updateConfig } = useConfig();
	const [config, setConfig] = useState<Config>({});
	const [initialized, setInitialized] = useState(false);
	const autoSave = useAutoSave(updateConfig);

	useEffect(() => {
		if (!loading) {
			setConfig(globalConfig);
			if (!initialized) setInitialized(true);
		}
	}, [globalConfig, loading, initialized]);

	const update = useCallback(
		(patch: ConfigPatch) => {
			setConfig((prev) => applyConfigPatch(prev, patch));
			autoSave(patch);
		},
		[autoSave],
	);

	return { config, loading, initialized, update, autoSave, setConfig, updateConfig };
}
