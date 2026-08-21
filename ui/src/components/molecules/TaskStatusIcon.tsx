import {
	Circle,
	CircleAlert,
	CircleCheckBig,
	CircleDotDashed,
	CirclePause,
	CircleX,
	Eye,
	ListTodo,
} from "lucide-react";
import { useConfig } from "@/ui/contexts/ConfigContext";
import { cn } from "@/ui/lib/utils";
import {
	getStatusBadgeClasses,
	getStatusLabel,
	type ColorName,
} from "@/ui/utils/colors";

interface TaskStatusIconProps {
	status: string;
	className?: string;
	showLabel?: boolean;
}

const STATUS_ICONS = {
	todo: Circle,
	"in-progress": CircleDotDashed,
	"in-review": Eye,
	done: CircleCheckBig,
	blocked: CircleX,
	"on-hold": CirclePause,
	urgent: CircleAlert,
} as const;

const ACCESSIBLE_STATUS_LABELS: Record<string, string> = {
	todo: "New",
	"in-progress": "In progress",
	"in-review": "In review",
	done: "Done",
	blocked: "Blocked",
	"on-hold": "On hold",
	urgent: "Urgent",
};

export function TaskStatusIcon({
	status,
	className,
	showLabel = false,
}: TaskStatusIconProps) {
	const { config } = useConfig();
	const statusColors = (config.statusColors || {}) as Record<string, ColorName>;
	const Icon = STATUS_ICONS[status as keyof typeof STATUS_ICONS] || ListTodo;
	const label = getStatusLabel(status);
	const accessibleLabel = ACCESSIBLE_STATUS_LABELS[status] || label;

	return (
		<span
			className={cn(
				getStatusBadgeClasses(status, statusColors),
				"inline-flex shrink-0 items-center gap-1.5 bg-transparent text-xs font-medium dark:bg-transparent",
				className,
			)}
			aria-label={showLabel ? undefined : `Task status: ${accessibleLabel}`}
			title={showLabel ? undefined : accessibleLabel}
		>
			<Icon className="size-3.5" aria-hidden="true" />
			{showLabel && <span className="text-foreground">{label}</span>}
		</span>
	);
}
