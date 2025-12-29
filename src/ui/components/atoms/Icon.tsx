import {
	AlertCircle,
	ArrowDown,
	ArrowUp,
	Calendar,
	Check,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Circle,
	Clock,
	Edit,
	ExternalLink,
	FileText,
	Loader2,
	Minus,
	MoreHorizontal,
	Pause,
	Play,
	Plus,
	RefreshCw,
	Search,
	Settings,
	Square,
	Trash2,
	User,
	X,
	type LucideIcon,
} from "lucide-react";
import { cn } from "@/ui/lib/utils";

const icons = {
	"alert-circle": AlertCircle,
	"arrow-down": ArrowDown,
	"arrow-up": ArrowUp,
	calendar: Calendar,
	check: Check,
	"check-circle": CheckCircle2,
	"chevron-down": ChevronDown,
	"chevron-right": ChevronRight,
	circle: Circle,
	clock: Clock,
	edit: Edit,
	"external-link": ExternalLink,
	"file-text": FileText,
	loader: Loader2,
	minus: Minus,
	more: MoreHorizontal,
	pause: Pause,
	play: Play,
	plus: Plus,
	refresh: RefreshCw,
	search: Search,
	settings: Settings,
	square: Square,
	trash: Trash2,
	user: User,
	x: X,
} as const;

export type IconName = keyof typeof icons;

interface IconProps {
	name: IconName;
	size?: "sm" | "md" | "lg";
	className?: string;
}

const sizeClasses = {
	sm: "w-3 h-3",
	md: "w-4 h-4",
	lg: "w-5 h-5",
};

export function Icon({ name, size = "md", className }: IconProps) {
	const IconComponent: LucideIcon = icons[name];

	if (!IconComponent) {
		console.warn(`Icon "${name}" not found`);
		return null;
	}

	return <IconComponent className={cn(sizeClasses[size], className)} />;
}
