import { Moon, Sun } from "lucide-react";
import { SidebarMenuButton } from "../ui/sidebar";

interface SidebarThemeControlProps {
	isDark: boolean;
	onToggle: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

export function SidebarThemeControl({
	isDark,
	onToggle,
}: SidebarThemeControlProps) {
	const Icon = isDark ? Moon : Sun;

	return (
		<SidebarMenuButton
			type="button"
			role="switch"
			aria-checked={isDark}
			aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
			tooltip={isDark ? "Light mode" : "Dark mode"}
			onClick={onToggle}
		>
			<Icon aria-hidden="true" />
			<span>Dark mode</span>
			<span
				aria-hidden="true"
				className="ml-auto flex h-4 w-7 shrink-0 items-center rounded-full bg-sidebar-border p-0.5 transition-colors group-data-[collapsible=icon]:hidden"
			>
				<span
					className={`size-3 rounded-full bg-sidebar-foreground transition-transform ${
						isDark ? "translate-x-3" : "translate-x-0"
					}`}
				/>
			</span>
		</SidebarMenuButton>
	);
}
