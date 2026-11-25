import { createContext, useContext } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { ConfigProvider } from "./contexts/ConfigContext";
import { UserProvider } from "./contexts/UserContext";
import { UIPreferencesProvider } from "./contexts/UIPreferencesContext";
import { SSEProvider } from "./contexts/SSEContext";
import { OperationsProvider } from "./contexts/OperationsContext";
import { ServerUpdateNotice } from "./components/organisms/ServerUpdateNotice";
import { TimeTrackerProvider } from "./contexts/TimeTrackerContext";
import { GlobalTaskProvider } from "./contexts/GlobalTaskContext";
import { AuthProvider } from "./contexts/AuthContext";
import { LoginGate } from "./components/LoginGate";
import { router } from "./router";
import { Agentation } from "agentation";

interface ThemeContextType {
	isDark: boolean;
	toggle: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

export const ThemeContext = createContext<ThemeContextType>({
	isDark: false,
	toggle: () => {},
});

declare global {
	interface Document {
		startViewTransition?: (callback: () => void) => {
			ready: Promise<void>;
			finished: Promise<void>;
		};
	}
}

export const useTheme = () => useContext(ThemeContext);

export default function App() {
	return (
		<AuthProvider>
			<LoginGate>
				<ConfigProvider>
					<UserProvider>
						<UIPreferencesProvider>
							<SSEProvider>
								<OperationsProvider>
									<TimeTrackerProvider>
										<GlobalTaskProvider>
											<RouterProvider router={router} />
											<ServerUpdateNotice />
											{import.meta.env.DEV && <Agentation />}
										</GlobalTaskProvider>
									</TimeTrackerProvider>
								</OperationsProvider>
							</SSEProvider>
						</UIPreferencesProvider>
					</UserProvider>
				</ConfigProvider>
			</LoginGate>
		</AuthProvider>
	);
}
