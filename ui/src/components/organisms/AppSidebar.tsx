import {
	LayoutDashboard,
	ListTodo,
	FileText,
	Settings,
	Search,
	Github,
	ExternalLink,
	ArrowRightLeft,
	Network,
	Brain,
	ScrollText,
	Activity,
	Monitor,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import logoImage from "../../public/logo.png";
import {
	Sidebar,
	SidebarContent,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
	SidebarFooter,
	useSidebar,
} from "@/ui/components/ui/sidebar";
import { useConfig } from "@/ui/contexts/ConfigContext";
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

const navigationGroups = [
	{
		label: "Workspace",
		items: [
			{
				id: "dashboard",
				label: "Dashboard",
				icon: LayoutDashboard,
				to: "/",
			},
			{
				id: "tasks",
				label: "Tasks",
				icon: ListTodo,
				to: "/tasks",
			},
		],
	},
	{
		label: "Knowledge",
		items: [
			{
				id: "docs",
				label: "Docs",
				icon: FileText,
				to: "/docs",
			},
			{
				id: "graph",
				label: "Graph",
				icon: Network,
				to: "/graph",
			},
			{
				id: "memory",
				label: "Memories",
				icon: Brain,
				to: "/memory",
			},
			{
				id: "decisions",
				label: "System Decisions",
				icon: ScrollText,
				to: "/decisions",
			},
		],
	},
	{
		label: "System",
		items: [
			{
				id: "runtime",
				label: "Runtime",
				icon: Monitor,
				to: "/runtime",
			},
			{
				id: "audit",
				label: "Audit Trail",
				icon: Activity,
				to: "/audit",
			},
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
	const { state, isMobile, setOpenMobile } = useSidebar();
	const isExpanded = state === "expanded";
	const { config } = useConfig();
	const closeMobileSidebar = () => {
		if (isMobile) setOpenMobile(false);
	};

	return (
		<Sidebar collapsible="icon" variant={isMobile ? "floating" : "sidebar"}>
			{/* Header: workspace switcher + search */}
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton
							type="button"
							size="lg"
							onClick={() => {
								closeMobileSidebar();
								onWorkspacePickerClick();
							}}
							tooltip="Switch workspace"
							className="group/workspace"
						>
							<img
								src={logoImage}
								alt=""
								className="size-8 shrink-0 rounded-lg object-contain"
							/>
							<span className="min-w-0 flex-1 truncate font-semibold">
								{config.name || "Knowns"}
							</span>
							<ArrowRightLeft className="text-muted-foreground group-data-[collapsible=icon]:hidden" />
						</SidebarMenuButton>
					</SidebarMenuItem>
					<SidebarMenuItem>
						<SidebarMenuButton
							type="button"
							onClick={() => {
								closeMobileSidebar();
								onSearchClick();
							}}
							tooltip="Search"
						>
							<Search />
							<span>Search...</span>
							<kbd className="pointer-events-none ml-auto hidden h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground group-data-[collapsible=icon]:hidden lg:inline-flex">
								<span className="text-xs">⌘</span>K
							</kbd>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
				<div className="group-data-[collapsible=icon]:hidden">
					<ConnectionStatus />
				</div>
			</SidebarHeader>

			<SidebarContent>
				{/* Top Navigation */}
				{navigationGroups.map((group) => (
					<SidebarGroup key={group.label}>
						<SidebarGroupLabel>{group.label}</SidebarGroupLabel>
						<SidebarGroupContent>
							<SidebarMenu>
								{group.items.map((item) => {
									// /kanban now renders the Tasks page pinned to the Board view,
									// so it must keep the Tasks entry highlighted.
									const activePage = currentPage === "kanban" ? "tasks" : currentPage;
									const isActive = activePage === item.id;
									return (
										<SidebarMenuItem key={item.id}>
											<SidebarMenuButton
												asChild
												isActive={isActive}
												tooltip={item.label}
											>
												<Link to={item.to} onClick={closeMobileSidebar}>
													<item.icon />
													<span>{item.label}</span>
												</Link>
											</SidebarMenuButton>
										</SidebarMenuItem>
									);
								})}
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
				))}
			</SidebarContent>

			<SidebarFooter>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton
							asChild
							isActive={currentPage === "config"}
							tooltip="Settings"
						>
							<Link to="/config" onClick={closeMobileSidebar}>
								<Settings />
								<span>Settings</span>
							</Link>
						</SidebarMenuButton>
					</SidebarMenuItem>
					<SidebarMenuItem>
						<SidebarThemeControl isDark={isDark} onToggle={onThemeToggle} />
					</SidebarMenuItem>
				</SidebarMenu>

				{/* GitHub + Version */}
				{isExpanded && (
					<div className="px-3 py-2 text-xs text-sidebar-foreground/50">
						<div className="flex items-center justify-between">
							<a
								href="https://github.com/knowns-dev/knowns"
								target="_blank"
								rel="noopener noreferrer"
								className="hover:text-sidebar-foreground transition-colors flex items-center gap-1"
							>
								<Github className="w-3 h-3" />
								GitHub
								<ExternalLink className="w-2.5 h-2.5" />
							</a>
							<a
								href="https://knowns.sh/changelog"
								target="_blank"
								rel="noopener noreferrer"
								className="font-mono hover:text-sidebar-foreground transition-colors truncate max-w-[120px]"
								title={serverVersion || import.meta.env.APP_VERSION}
							>
								{serverVersion || import.meta.env.APP_VERSION}
							</a>
						</div>
					</div>
				)}
			</SidebarFooter>

			<SidebarRail />
		</Sidebar>
	);
}
