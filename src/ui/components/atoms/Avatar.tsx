import { useMemo } from "react";

interface AvatarProps {
	name: string;
	size?: "xs" | "sm" | "md" | "lg";
	className?: string;
}

// Color classes with dark: variants combined
const colorClasses = [
	"bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300",
	"bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300",
	"bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300",
	"bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300",
	"bg-pink-100 text-pink-700 dark:bg-pink-900/50 dark:text-pink-300",
	"bg-teal-100 text-teal-700 dark:bg-teal-900/50 dark:text-teal-300",
	"bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300",
	"bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300",
];

// Generate consistent color from username
function generateColorClass(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = name.charCodeAt(i) + ((hash << 5) - hash);
	}
	return colorClasses[Math.abs(hash) % colorClasses.length];
}

// Get initials from username (e.g., "@harry" → "H", "@john-doe" → "JD")
function getInitials(name: string): string {
	const cleanName = name.replace(/^@/, "");
	const parts = cleanName.split(/[-_\s]+/);

	if (parts.length >= 2) {
		return (parts[0][0] + parts[1][0]).toUpperCase();
	}

	return cleanName.slice(0, 2).toUpperCase();
}

const sizeClasses = {
	xs: "w-4 h-4 text-[8px]",
	sm: "w-5 h-5 text-[10px]",
	md: "w-7 h-7 text-xs",
	lg: "w-9 h-9 text-sm",
};

export default function Avatar({ name, size = "md", className = "" }: AvatarProps) {
	const { initials, colorClass } = useMemo(() => {
		return {
			initials: getInitials(name),
			colorClass: generateColorClass(name),
		};
	}, [name]);

	return (
		<div
			className={`inline-flex items-center justify-center rounded-full font-medium shrink-0 ${sizeClasses[size]} ${colorClass} ${className}`}
			title={name}
		>
			{initials}
		</div>
	);
}
