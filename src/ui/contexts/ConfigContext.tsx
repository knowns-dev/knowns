import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { getConfig, saveConfig } from "../api/client";

// Config interface (matches ConfigPage.tsx)
export interface Config {
	name?: string;
	defaultAssignee?: string;
	defaultPriority?: "low" | "medium" | "high";
	defaultLabels?: string[];
	timeFormat?: "12h" | "24h";
	editor?: string;
	visibleColumns?: string[];
	statuses?: string[];
	statusColors?: Record<string, string>;
}

interface ConfigContextType {
	config: Config;
	loading: boolean;
	error: Error | null;
	updateConfig: (updates: Partial<Config>) => Promise<void>;
	refetch: () => Promise<void>;
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
};

export function ConfigProvider({ children }: { children: ReactNode }) {
	const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<Error | null>(null);

	const fetchConfig = async () => {
		try {
			setLoading(true);
			setError(null);
			const data = await getConfig();
			setConfig({ ...DEFAULT_CONFIG, ...data } as Config);
		} catch (err) {
			setError(err instanceof Error ? err : new Error("Failed to fetch config"));
			setConfig(DEFAULT_CONFIG);
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		fetchConfig();
	}, []);

	const updateConfig = async (updates: Partial<Config>) => {
		const prevConfig = config;
		const newConfig = { ...config, ...updates };
		setConfig(newConfig); // Optimistic update

		try {
			await saveConfig(newConfig);
		} catch (err) {
			setConfig(prevConfig); // Rollback on error
			throw err;
		}
	};

	return (
		<ConfigContext.Provider
			value={{
				config,
				loading,
				error,
				updateConfig,
				refetch: fetchConfig,
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
