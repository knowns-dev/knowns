import { useTheme } from "../App";

interface SidebarProps {
	currentPage: string;
}

const Icons = {
	Kanban: () => (
		<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
			/>
		</svg>
	),
	List: () => (
		<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M4 6h16M4 12h16M4 18h16"
			/>
		</svg>
	),
	Document: () => (
		<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
			/>
		</svg>
	),
	Settings: () => (
		<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
			/>
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
			/>
		</svg>
	),
};

const menuItems = [
	{ id: "kanban", label: "Kanban", icon: Icons.Kanban },
	{ id: "tasks", label: "Tasks", icon: Icons.List },
	{ id: "docs", label: "Docs", icon: Icons.Document },
	{ id: "config", label: "Config", icon: Icons.Settings },
];

export default function Sidebar({ currentPage }: SidebarProps) {
	const { isDark } = useTheme();

	const bgColor = isDark ? "bg-gray-800" : "bg-white";
	const textColor = isDark ? "text-gray-300" : "text-gray-600";
	const textColorActive = isDark ? "text-white" : "text-gray-900";
	const bgHover = isDark ? "hover:bg-gray-700" : "hover:bg-gray-100";
	const bgActive = isDark ? "bg-gray-700" : "bg-gray-200";

	return (
		<aside className={`w-64 ${bgColor} shadow-lg h-screen sticky top-0 flex flex-col`}>
			{/* Logo */}
			<div className="p-6 border-b border-gray-700">
				<h2 className={`text-xl font-bold ${textColorActive}`}>◆ Knowns.dev</h2>
			</div>

			{/* Navigation */}
			<nav className="flex-1 p-4 space-y-2">
				{menuItems.map((item) => {
					const Icon = item.icon;
					const isActive = currentPage === item.id;
					const href = item.id === "kanban" ? "#/" : `#/${item.id}`;

					return (
						<a
							key={item.id}
							href={href}
							className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
								isActive ? `${bgActive} ${textColorActive} font-medium` : `${textColor} ${bgHover}`
							}`}
						>
							<Icon />
							<span>{item.label}</span>
						</a>
					);
				})}
			</nav>
		</aside>
	);
}
