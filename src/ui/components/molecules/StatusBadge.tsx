import { Badge } from "../atoms";
import { cn } from "@/ui/lib/utils";
import { useConfig } from "../../contexts/ConfigContext";
import { getStatusBadgeClasses, getStatusLabel, type ColorName } from "../../utils/colors";

interface StatusBadgeProps {
	status: string;
	className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
	const { config } = useConfig();
	const statusColors = (config.statusColors || {}) as Record<string, ColorName>;

	return (
		<Badge className={cn(getStatusBadgeClasses(status, statusColors), className)}>
			{getStatusLabel(status)}
		</Badge>
	);
}
