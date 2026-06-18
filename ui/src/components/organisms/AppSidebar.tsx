import {
	LayoutDashboard,
	LayoutGrid,
	ListTodo,
	FileText,
	Download,
	MessageSquare,
	Settings,
	Search,
	Github,
	ExternalLink,
	ArrowRightLeft,
	Network,
	Brain,
	ScrollText,
	Activity,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import logoImage from "../../public/logo.png";
import {
	Sidebar,
	SidebarContent,
	SidebarGroup,
	SidebarGroupContent,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
	SidebarFooter,
	useSidebar,
} from "@/ui/components/ui/sidebar";
import { useIsMobile } from "@/ui/hooks/useMobile";
import { useConfig } from "@/ui/contexts/ConfigContext";

interface AppSidebarProps {
	currentPage: string;
	onSearchClick: () => void;
	onWorkspacePickerClick: () => void;
	serverVersion?: string;
}

const topNavItems = [
	{
		id: "chat",
		label: "AI Chat",
		icon: MessageSquare,
		to: "/chat",
	},
	{
		id: "dashboard",
		label: "Dashboard",
		icon: LayoutDashboard,
		to: "/",
	},
	{
		id: "kanban",
		label: "Kanban",
		icon: LayoutGrid,
		to: "/kanban",
	},
	{
		id: "tasks",
		label: "Tasks",
		icon: ListTodo,
		to: "/tasks",
	},
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
		label: "Decisions",
		icon: ScrollText,
		to: "/decisions",
	},
	{
		id: "audit",
		label: "Audit Trail",
		icon: Activity,
		to: "/audit",
	},
];

export function AppSidebar({
	currentPage,
	onSearchClick,
	onWorkspacePickerClick,
	serverVersion,
}: AppSidebarProps) {
	const { state } = useSidebar();
	const isMobile = useIsMobile();
	const isExpanded = state === "expanded";
	const { config, chatUIEnabled } = useConfig();
	const visibleNavItems = topNavItems.filter(
		(item) => item.id !== "chat" || chatUIEnabled
	);

	return (
		<Sidebar collapsible="icon" variant={isMobile ? "floating" : "sidebar"}>
			{/* Header: Logo + Project Name + Version */}
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						<div className="flex w-full items-center gap-2 rounded-md p-2 text-left">
								<img
									src={logoImage}
									alt="Knowns"
									className="size-8 rounded-lg object-contain"
								/>
								<div className="grid flex-1 text-left text-sm leading-tight">
									<span className="truncate font-semibold">
										{config.name || "Knowns"}
									</span>
								</div>
								{isExpanded && (
									<button
										type="button"
										onClick={onWorkspacePickerClick}
										className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
										title="Switch workspace"
									>
										<ArrowRightLeft className="h-4 w-4" />
									</button>
								)}
						</div>
					</SidebarMenuItem>
				</SidebarMenu>

				{/* Search Button */}
				{isExpanded && (
					<div className="px-2 pb-2">
						<button
							type="button"
							onClick={onSearchClick}
							className="flex w-full items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
						>
							<Search className="h-4 w-4" />
							<span>Search...</span>
							<kbd className="ml-auto pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
								<span className="text-xs">⌘</span>K
							</kbd>
						</button>
					</div>
				)}
			</SidebarHeader>

			<SidebarContent>
				{/* Top Navigation */}
				<SidebarGroup>
					<SidebarGroupContent>
						<SidebarMenu>
							{visibleNavItems.map((item) => {
								const isActive = currentPage === item.id;
								return (
									<SidebarMenuItem key={item.id}>
										<SidebarMenuButton
											asChild
											isActive={isActive}
											tooltip={item.label}
										>
											<Link to={item.to}>
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

			</SidebarContent>

			<SidebarFooter>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton
							asChild
							isActive={currentPage === "config"}
							tooltip="Settings"
						>
							<Link to="/config">
								<Settings />
								<span>Settings</span>
							</Link>
						</SidebarMenuButton>
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
