import { useMemo } from "react";
import { useTheme } from "../App";

interface AvatarProps {
	name: string;
	size?: "xs" | "sm" | "md" | "lg";
	className?: string;
}

// Generate consistent color from username
function generateColor(name: string): { bg: string; darkBg: string } {
	const colors = [
		{ bg: "bg-blue-100 text-blue-700", darkBg: "bg-blue-900/50 text-blue-300" },
		{ bg: "bg-green-100 text-green-700", darkBg: "bg-green-900/50 text-green-300" },
		{ bg: "bg-purple-100 text-purple-700", darkBg: "bg-purple-900/50 text-purple-300" },
		{ bg: "bg-orange-100 text-orange-700", darkBg: "bg-orange-900/50 text-orange-300" },
		{ bg: "bg-pink-100 text-pink-700", darkBg: "bg-pink-900/50 text-pink-300" },
		{ bg: "bg-teal-100 text-teal-700", darkBg: "bg-teal-900/50 text-teal-300" },
		{ bg: "bg-indigo-100 text-indigo-700", darkBg: "bg-indigo-900/50 text-indigo-300" },
		{ bg: "bg-cyan-100 text-cyan-700", darkBg: "bg-cyan-900/50 text-cyan-300" },
	];

	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = name.charCodeAt(i) + ((hash << 5) - hash);
	}

	return colors[Math.abs(hash) % colors.length];
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
	const { isDark } = useTheme();

	const { initials, colorClass } = useMemo(() => {
		const color = generateColor(name);
		return {
			initials: getInitials(name),
			colorClass: isDark ? color.darkBg : color.bg,
		};
	}, [name, isDark]);

	return (
		<div
			className={`inline-flex items-center justify-center rounded-full font-medium shrink-0 ${sizeClasses[size]} ${colorClass} ${className}`}
			title={name}
		>
			{initials}
		</div>
	);
}
