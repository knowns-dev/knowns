import {
	LayoutDashboard,
	ListTodo,
	FileText,
	Settings,
	Github,
	ExternalLink,
	Network,
	Brain,
	ScrollText,
	Activity,
	Monitor,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import logoImage from "../../public/logo.png";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarHeader,
	SidebarItem,
	SidebarNav,
	SidebarSearch,
	useSidebar,
	type SidebarNode,
} from "@/ui/components/ui/knowns/blocks/sidebar/sidebar";
import { Tooltip } from "@/ui/components/ui/knowns/tooltip";
import { useConfig } from "@/ui/contexts/ConfigContext";
import { cn } from "@/ui/lib/utils";
import { ConnectionStatus } from "../atoms";
import { SidebarThemeControl } from "../molecules";

interface AppSidebarProps {
	currentPage: string;
	onSearchClick: () => void;
	onWorkspacePickerClick: () => void;
	isDark: boolean;
	onThemeToggle: (event: React.MouseEvent<HTMLButtonElement>) => void;
	serverVersion?: string;
}

/** The Knowns UI sidebar renders links with `href`; TanStack Router's Link takes `to`. */
function RouterLink({ href, ...props }: Omit<ComponentProps<"a">, "href"> & { href: string }) {
	return <Link to={href} {...props} />;
}

/** Hidden in the icon rail; the sheet and the expanded sidebar show it. */
const HIDE_IN_RAIL = "group-data-[rail]/sb:hidden";

const navigationGroups: { label: string; items: SidebarNode[] }[] = [
	{
		label: "Workspace",
		items: [
			{ id: "dashboard", label: "Dashboard", icon: <LayoutDashboard />, href: "/" },
			{ id: "tasks", label: "Tasks", icon: <ListTodo />, href: "/tasks" },
		],
	},
	{
		label: "Knowledge",
		items: [
			{ id: "docs", label: "Docs", icon: <FileText />, href: "/docs" },
			{ id: "graph", label: "Graph", icon: <Network />, href: "/graph" },
			{ id: "memory", label: "Memories", icon: <Brain />, href: "/memory" },
			{ id: "decisions", label: "System Decisions", icon: <ScrollText />, href: "/decisions" },
		],
	},
	{
		label: "System",
		items: [
			{ id: "runtime", label: "Runtime", icon: <Monitor />, href: "/runtime" },
			{ id: "audit", label: "Audit Trail", icon: <Activity />, href: "/audit" },
		],
	},
];

export function AppSidebar({
	currentPage,
	onSearchClick,
	onWorkspacePickerClick,
	isDark,
	onThemeToggle,
	serverVersion,
}: AppSidebarProps) {
	const { collapsed, isMobile, setMobileOpen } = useSidebar();
	const { config } = useConfig();
	const projectName = config.name || "Knowns";
	const version = serverVersion || import.meta.env.APP_VERSION;
	// /kanban renders the Tasks page pinned to the Board view, so it keeps Tasks highlighted.
	const activePage = currentPage === "kanban" ? "tasks" : currentPage;
	// Links close the mobile sheet on their own; these open a dialog, so close it first.
	const closeSheetThen = (open: () => void) => () => {
		if (isMobile) setMobileOpen(false);
		open();
	};

	return (
		<Sidebar label="Knowns">
			<SidebarHeader>
				<Tooltip content="Switch workspace" side="right" disabled={!collapsed || isMobile} className="flex w-full">
					<button
						type="button"
						onClick={closeSheetThen(onWorkspacePickerClick)}
						aria-label={`${projectName}, switch workspace`}
						className="flex h-11 w-full min-w-0 items-center gap-2.5 rounded-lg px-1.5 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50"
					>
						<img src={logoImage} alt="" className="size-8 shrink-0 rounded-lg object-contain" />
						<span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground transition-opacity group-data-[rail]/sb:opacity-0">
							{projectName}
						</span>
						<svg
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
							className="size-3.5 shrink-0 text-muted-foreground transition-opacity group-data-[rail]/sb:opacity-0"
						>
							<path d="M5 6l3-3 3 3M5 10l3 3 3-3" />
						</svg>
					</button>
				</Tooltip>
				<SidebarSearch label="Search..." onOpen={closeSheetThen(onSearchClick)} />
				<div className={HIDE_IN_RAIL}>
					<ConnectionStatus />
				</div>
			</SidebarHeader>

			<SidebarContent>
				{navigationGroups.map((group) => (
					<SidebarGroup key={group.label} label={group.label}>
						<SidebarNav
							items={group.items}
							active={activePage}
							linkAs={RouterLink}
							label={group.label}
						/>
					</SidebarGroup>
				))}
			</SidebarContent>

			<SidebarFooter>
				<SidebarItem
					label="Settings"
					icon={<Settings />}
					href="/config"
					active={currentPage === "config"}
					linkAs={RouterLink}
				/>
				<SidebarThemeControl isDark={isDark} onToggle={onThemeToggle} />
				<div className={cn("flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-muted-foreground", HIDE_IN_RAIL)}>
					<a
						href="https://github.com/knowns-dev/knowns"
						target="_blank"
						rel="noopener noreferrer"
						className="flex items-center gap-1 rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
					>
						<Github className="size-3" />
						GitHub
						<ExternalLink className="size-2.5" />
					</a>
					<a
						href="https://knowns.sh/changelog"
						target="_blank"
						rel="noopener noreferrer"
						className="max-w-[120px] truncate rounded-sm font-mono outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
						title={version}
					>
						{version}
					</a>
				</div>
			</SidebarFooter>
		</Sidebar>
	);
}
