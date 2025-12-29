import { Icon, type IconName } from "../atoms";
import { cn } from "@/ui/lib/utils";

type Priority = "low" | "medium" | "high";

interface PriorityBadgeProps {
	priority: Priority;
	className?: string;
}

const priorityConfig: Record<Priority, { icon: IconName; colorClass: string }> = {
	low: {
		icon: "arrow-down",
		colorClass: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-800",
	},
	medium: {
		icon: "minus",
		colorClass: "bg-yellow-100 text-yellow-700 border-yellow-200 dark:bg-yellow-900/40 dark:text-yellow-300 dark:border-yellow-800",
	},
	high: {
		icon: "arrow-up",
		colorClass: "bg-red-100 text-red-700 border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-800",
	},
};

export function PriorityBadge({ priority, className }: PriorityBadgeProps) {
	const config = priorityConfig[priority] || priorityConfig.medium;

	return (
		<div
			className={cn(
				"inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
				config.colorClass,
				className
			)}
		>
			<Icon name={config.icon} size="sm" />
			<span className="capitalize">{priority}</span>
		</div>
	);
}
