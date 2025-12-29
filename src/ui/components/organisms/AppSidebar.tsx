import {
	LayoutDashboard,
	ListTodo,
	FileText,
	Settings,
	Search,
} from "lucide-react";
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
import { useIsMobile } from "@/ui/hooks/use-mobile";

interface AppSidebarProps {
	currentPage: string;
	onSearchClick: () => void;
}

const menuItems = [
	{
		id: "kanban",
		label: "Kanban",
		icon: LayoutDashboard,
		href: "#/",
	},
	{
		id: "tasks",
		label: "Tasks",
		icon: ListTodo,
		href: "#/tasks",
	},
	{
		id: "docs",
		label: "Docs",
		icon: FileText,
		href: "#/docs",
	},
];

export function AppSidebar({
	currentPage,
	onSearchClick,
}: AppSidebarProps) {
	const { state } = useSidebar();
	const isMobile = useIsMobile();
	const isExpanded = state === "expanded";

	return (
		<Sidebar collapsible="icon" variant={isMobile ? "floating" : "sidebar"}>
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton size="lg" asChild>
							<a href="#/">
								<div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
									<span className="text-lg font-bold">◆</span>
								</div>
								<div className="grid flex-1 text-left text-sm leading-tight">
									<span className="truncate font-semibold">Knowns.dev</span>
									<span className="truncate text-xs">Task Management</span>
								</div>
							</a>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>

				{/* Search Button - conditionally rendered when expanded */}
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
				<SidebarGroup>
					<SidebarGroupLabel>Navigation</SidebarGroupLabel>
					<SidebarGroupContent>
						<SidebarMenu>
							{menuItems.map((item) => {
								const isActive = currentPage === item.id;
								return (
									<SidebarMenuItem key={item.id}>
										<SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
											<a href={item.href}>
												<item.icon />
												<span>{item.label}</span>
											</a>
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
							<a href="#/config">
								<Settings />
								<span>Settings</span>
							</a>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>

				{/* Version - conditionally rendered when expanded */}
				{isExpanded && (
					<div className="px-3 py-2 text-xs text-sidebar-foreground/50">
						<div className="flex items-center justify-between">
							<a
								href="https://github.com/knowns-dev/knowns"
								target="_blank"
								rel="noopener noreferrer"
								className="hover:text-sidebar-foreground transition-colors"
							>
								Knowns
							</a>
							<span className="font-mono">{import.meta.env.APP_VERSION}</span>
						</div>
					</div>
				)}
			</SidebarFooter>

			<SidebarRail />
		</Sidebar>
	);
}
