import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { authApi } from "@/ui/api/client";

interface AuthContextType {
	isProtected: boolean;
	isAuthenticated: boolean;
	isLoading: boolean;
	token: string | null;
	login: (password: string) => Promise<void>;
	setPassword: (password: string) => Promise<void>;
	removePassword: () => Promise<void>;
	refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
	isProtected: false,
	isAuthenticated: false,
	isLoading: true,
	token: null,
	login: async () => {},
	setPassword: async () => {},
	removePassword: async () => {},
	refresh: async () => {},
});

export const useAuth = () => useContext(AuthContext);

const TOKEN_KEY = "knowns_auth_token";

export function AuthProvider({ children }: { children: ReactNode }) {
	const [isProtected, setIsProtected] = useState(false);
	const [isAuthenticated, setIsAuthenticated] = useState(false);
	const [isLoading, setIsLoading] = useState(true);
	const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY));

	const refresh = useCallback(async () => {
		try {
			const status = await authApi.getStatus();
			setIsProtected(status.protected);
			setIsAuthenticated(status.authenticated);
			if (!status.protected) {
				setToken(null);
				sessionStorage.removeItem(TOKEN_KEY);
			}
		} catch {
			setIsProtected(false);
			setIsAuthenticated(false);
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const login = useCallback(async (password: string) => {
		const res = await authApi.login(password);
		const t = (res as unknown as { token?: string }).token || null;
		setToken(t);
		if (t) sessionStorage.setItem(TOKEN_KEY, t);
		setIsAuthenticated(true);
	}, []);

	const setPassword = useCallback(async (password: string) => {
		const res = await authApi.setPassword(password);
		const t = res?.token || null;
		setToken(t);
		if (t) sessionStorage.setItem(TOKEN_KEY, t);
		setIsProtected(true);
		setIsAuthenticated(true);
	}, []);

	const removePassword = useCallback(async () => {
		await authApi.removePassword();
		setIsProtected(false);
		setIsAuthenticated(false);
		setToken(null);
		sessionStorage.removeItem(TOKEN_KEY);
	}, []);

	return (
		<AuthContext.Provider value={{ isProtected, isAuthenticated, isLoading, token, login, setPassword, removePassword, refresh }}>
			{children}
		</AuthContext.Provider>
	);
}
