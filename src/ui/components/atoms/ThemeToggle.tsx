import { Sun, Moon } from "lucide-react";
import { cn } from "@/ui/lib/utils";

interface ThemeToggleProps {
	isDark: boolean;
	onToggle: (event: React.MouseEvent<HTMLButtonElement>) => void;
	size?: "sm" | "md" | "lg";
	className?: string;
}

const sizeClasses = {
	sm: "w-12 h-6",
	md: "w-14 h-7",
	lg: "w-16 h-8",
};

const circleClasses = {
	sm: "w-5 h-5",
	md: "w-6 h-6",
	lg: "w-7 h-7",
};

const iconClasses = {
	sm: "w-3 h-3",
	md: "w-3.5 h-3.5",
	lg: "w-4 h-4",
};

const translateClasses = {
	sm: "translate-x-6",
	md: "translate-x-7",
	lg: "translate-x-8",
};

export function ThemeToggle({
	isDark,
	onToggle,
	size = "md",
	className,
}: ThemeToggleProps) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={isDark}
			aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
			onClick={onToggle}
			className={cn(
				"relative inline-flex shrink-0 cursor-pointer rounded-full border-2 border-transparent",
				"transition-colors duration-300 ease-in-out",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
				isDark
					? "bg-slate-700"
					: "bg-gradient-to-r from-sky-400 to-blue-500",
				sizeClasses[size],
				className,
			)}
		>
			{/* Track decoration - stars/clouds */}
			<span
				className={cn(
					"absolute inset-0 flex items-center justify-between px-1.5 pointer-events-none",
					"transition-opacity duration-300",
				)}
			>
				{/* Stars (visible in dark mode) */}
				<span
					className={cn(
						"flex gap-0.5 transition-opacity duration-300",
						isDark ? "opacity-100" : "opacity-0",
					)}
				>
					<span className="w-0.5 h-0.5 rounded-full bg-white/80" />
					<span className="w-1 h-1 rounded-full bg-white/60" />
					<span className="w-0.5 h-0.5 rounded-full bg-white/80" />
				</span>
				{/* Clouds (visible in light mode) */}
				<span
					className={cn(
						"flex gap-0.5 transition-opacity duration-300",
						isDark ? "opacity-0" : "opacity-100",
					)}
				>
					<span className="w-1.5 h-1 rounded-full bg-white/70" />
					<span className="w-1 h-0.5 rounded-full bg-white/50" />
				</span>
			</span>

			{/* Moving circle with sun/moon */}
			<span
				className={cn(
					"pointer-events-none inline-flex items-center justify-center rounded-full shadow-lg",
					"transform transition-all duration-300 ease-in-out",
					isDark
						? cn(translateClasses[size], "bg-slate-900")
						: "translate-x-0.5 bg-gradient-to-br from-yellow-300 to-orange-400",
					circleClasses[size],
				)}
			>
				{/* Sun icon */}
				<Sun
					className={cn(
						"absolute transition-all duration-300",
						iconClasses[size],
						isDark
							? "opacity-0 rotate-90 scale-0 text-yellow-500"
							: "opacity-100 rotate-0 scale-100 text-yellow-600",
					)}
				/>
				{/* Moon icon */}
				<Moon
					className={cn(
						"absolute transition-all duration-300",
						iconClasses[size],
						isDark
							? "opacity-100 rotate-0 scale-100 text-slate-300"
							: "opacity-0 -rotate-90 scale-0 text-slate-600",
					)}
				/>
			</span>
		</button>
	);
}
