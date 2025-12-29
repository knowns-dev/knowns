import { Badge } from "../atoms";
import { cn } from "@/ui/lib/utils";

interface LabelListProps {
	labels: string[];
	maxVisible?: number;
	className?: string;
}

// Generate consistent color from label name
function getLabelColor(label: string): string {
	const colors = [
		"bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
		"bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
		"bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
		"bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
		"bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-400",
		"bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-400",
	];

	let hash = 0;
	for (let i = 0; i < label.length; i++) {
		hash = label.charCodeAt(i) + ((hash << 5) - hash);
	}

	return colors[Math.abs(hash) % colors.length];
}

export function LabelList({ labels, maxVisible = 3, className }: LabelListProps) {
	if (!labels.length) return null;

	const visibleLabels = labels.slice(0, maxVisible);
	const hiddenCount = labels.length - maxVisible;

	return (
		<div className={cn("flex flex-wrap gap-1", className)}>
			{visibleLabels.map((label) => (
				<Badge key={label} variant="secondary" className={cn("text-xs", getLabelColor(label))}>
					{label}
				</Badge>
			))}
			{hiddenCount > 0 && (
				<Badge variant="outline" className="text-xs">
					+{hiddenCount}
				</Badge>
			)}
		</div>
	);
}
