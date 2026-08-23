import type { ReactNode } from "react";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { AppSidebar } from "../organisms/AppSidebar";

interface MainLayoutProps {
	children: ReactNode;
	currentPage?: string;
	onSearchClick?: () => void;
}

export function MainLayout({ children, currentPage = "dashboard", onSearchClick = () => {} }: MainLayoutProps) {
	return (
		<SidebarProvider>
			<AppSidebar
				currentPage={currentPage}
				onSearchClick={onSearchClick}
				onWorkspacePickerClick={() => {}}
				isDark={false}
				onThemeToggle={() => {}}
			/>
			<SidebarInset>
				<header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
					<SidebarTrigger className="-ml-1" />
				</header>
				<main className="flex-1 overflow-auto">{children}</main>
			</SidebarInset>
		</SidebarProvider>
	);
}
