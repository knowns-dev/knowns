import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

/**
 * Global Task Modal Context
 * Allows opening task detail modal from any page without navigation
 */

interface GlobalTaskContextType {
	/** Currently open task ID (null if no modal open) */
	currentTaskId: string | null;
	/** Open task detail modal */
	openTask: (taskId: string) => void;
	/** Close task detail modal */
	closeTask: () => void;
}

const GlobalTaskContext = createContext<GlobalTaskContextType | undefined>(undefined);

interface GlobalTaskProviderProps {
	children: ReactNode;
}

export function GlobalTaskProvider({ children }: GlobalTaskProviderProps) {
	const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);

	const openTask = useCallback((taskId: string) => {
		setCurrentTaskId(taskId);
	}, []);

	const closeTask = useCallback(() => {
		setCurrentTaskId(null);
		// NOTE: Do NOT change window.location.hash here
		// This allows modal to close while staying on current page
	}, []);

	return (
		<GlobalTaskContext.Provider value={{ currentTaskId, openTask, closeTask }}>
			{children}
		</GlobalTaskContext.Provider>
	);
}

export function useGlobalTask(): GlobalTaskContextType {
	const context = useContext(GlobalTaskContext);
	if (!context) {
		throw new Error("useGlobalTask must be used within a GlobalTaskProvider");
	}
	return context;
}
