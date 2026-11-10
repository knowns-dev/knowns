import { Moon, Sun } from "lucide-react";
import { Tooltip } from "@/ui/components/ui/knowns/tooltip";
import { useSidebar } from "@/ui/components/ui/knowns/blocks/sidebar/sidebar";
import { cn } from "@/ui/lib/utils";

interface SidebarThemeControlProps {
	isDark: boolean;
	onToggle: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

/**
 * The dark mode switch, drawn as a Knowns UI sidebar row. It is its own button rather than a
 * SidebarItem because the theme transition needs the click position from the event.
 */
export function SidebarThemeControl({
	isDark,
	onToggle,
}: SidebarThemeControlProps) {
	const Icon = isDark ? Moon : Sun;
	const label = isDark ? "Light mode" : "Dark mode";
	const { collapsed, isMobile } = useSidebar();

	return (
		<Tooltip content={label} side="right" disabled={!collapsed || isMobile} className="flex w-full">
			<button
				type="button"
				role="switch"
				aria-checked={isDark}
				aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
				onClick={onToggle}
				className={cn(
					"relative flex h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-3 text-left text-[13px] text-muted-foreground outline-none",
					"hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:h-10",
				)}
			>
				<Icon aria-hidden="true" className="size-4 shrink-0" />
				<span className="min-w-0 flex-1 truncate transition-opacity group-data-[rail]/sb:pointer-events-none group-data-[rail]/sb:opacity-0">
					Dark mode
				</span>
				<span
					aria-hidden="true"
					className="flex h-4 w-7 shrink-0 items-center rounded-full bg-border p-0.5 transition-opacity group-data-[rail]/sb:opacity-0"
				>
					<span
						className={cn(
							"size-3 rounded-full bg-foreground transition-transform",
							isDark ? "translate-x-3" : "translate-x-0",
						)}
					/>
				</span>
			</button>
		</Tooltip>
	);
}
