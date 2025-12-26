import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { getConfig } from "../api/client";

interface UserContextType {
	currentUser: string;
	setCurrentUser: (user: string) => void;
}

const UserContext = createContext<UserContextType | undefined>(undefined);

const USER_STORAGE_KEY = "knowns-current-user";
const DEFAULT_USER = "@me";

export function UserProvider({ children }: { children: ReactNode }) {
	const [currentUser, setCurrentUserState] = useState<string>(() => {
		try {
			return localStorage.getItem(USER_STORAGE_KEY) || DEFAULT_USER;
		} catch {
			return DEFAULT_USER;
		}
	});

	const setCurrentUser = (user: string) => {
		setCurrentUserState(user);
		try {
			localStorage.setItem(USER_STORAGE_KEY, user);
		} catch {
			// Ignore localStorage errors
		}
	};

	// Fetch user from config on mount
	useEffect(() => {
		getConfig()
			.then((config) => {
				if (config?.defaultAssignee) {
					setCurrentUser(config.defaultAssignee as string);
				}
			})
			.catch(() => {
				// Ignore errors, use default
			});
	}, []);

	return (
		<UserContext.Provider value={{ currentUser, setCurrentUser }}>{children}</UserContext.Provider>
	);
}

export function useCurrentUser() {
	const context = useContext(UserContext);
	if (context === undefined) {
		throw new Error("useCurrentUser must be used within a UserProvider");
	}
	return context;
}
