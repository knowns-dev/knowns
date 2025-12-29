import { Badge } from "../atoms";
import { cn } from "@/ui/lib/utils";

type TaskStatus = "todo" | "in-progress" | "in-review" | "blocked" | "done";

interface StatusBadgeProps {
	status: TaskStatus;
	className?: string;
}

const statusConfig: Record<TaskStatus, { label: string; variant: "default" | "warning" | "info" | "destructive" | "success" }> = {
	todo: { label: "To Do", variant: "default" },
	"in-progress": { label: "In Progress", variant: "warning" },
	"in-review": { label: "In Review", variant: "info" },
	blocked: { label: "Blocked", variant: "destructive" },
	done: { label: "Done", variant: "success" },
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
	const config = statusConfig[status] || statusConfig.todo;

	return (
		<Badge variant={config.variant} className={cn("capitalize", className)}>
			{config.label}
		</Badge>
	);
}
