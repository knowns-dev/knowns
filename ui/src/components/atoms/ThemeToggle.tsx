import { Sun, Moon } from "lucide-react";
import { cn } from "@/ui/lib/utils";

interface ThemeToggleProps {
	isDark: boolean;
	onToggle: (event: React.MouseEvent<HTMLButtonElement>) => void;
	size?: "sm" | "md" | "lg";
	className?: string;
}

const sizeMap = {
	sm: { track: "w-11 h-6", thumb: "w-5 h-5", icon: "w-3 h-3",     translate: "translate-x-5",  gap: "translate-x-0" },
	md: { track: "w-14 h-7", thumb: "w-6 h-6", icon: "w-3.5 h-3.5", translate: "translate-x-7",  gap: "translate-x-0" },
	lg: { track: "w-16 h-8", thumb: "w-7 h-7", icon: "w-4 h-4",     translate: "translate-x-8",  gap: "translate-x-0" },
};

export function ThemeToggle({
	isDark,
	onToggle,
	size = "md",
	className,
}: ThemeToggleProps) {
	const s = sizeMap[size];

	return (
		<button
			type="button"
			role="switch"
			aria-checked={isDark}
			aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
			onClick={onToggle}
			className={cn(
				"relative inline-flex items-center shrink-0 cursor-pointer rounded-full border-2 border-transparent",
				"transition-colors duration-(--kn-dur-slow) ease-(--kn-ease-inout)",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
				isDark
					? "bg-indigo-950"
					: "bg-sky-400",
				s.track,
				className,
			)}
		>
			{/* Stars — dark mode */}
			<span className="absolute inset-0 overflow-hidden rounded-full pointer-events-none">
				{[
					{ top: "20%", left: "18%", size: "w-0.5 h-0.5", delay: "0ms" },
					{ top: "55%", left: "25%", size: "w-1 h-1",     delay: "40ms" },
					{ top: "30%", left: "35%", size: "w-0.5 h-0.5", delay: "80ms" },
				].map((star, i) => (
					<span
						key={i}
						className={cn(
							"absolute rounded-full bg-white transition-opacity duration-(--kn-dur) ease-(--kn-ease-out)",
							star.size,
							isDark ? "opacity-80" : "opacity-0",
						)}
						style={{ top: star.top, left: star.left, transitionDelay: isDark ? star.delay : "0ms" }}
					/>
				))}
			</span>

			{/* Thumb */}
			<span
				className={cn(
					"relative inline-flex items-center justify-center rounded-full shadow-md",
					"transition-[transform,background-color] duration-(--kn-dur-slow) ease-(--kn-ease-inout)",
					isDark
						? cn(s.translate, "bg-slate-800")
						: cn(s.gap, "bg-white"),
					s.thumb,
				)}
			>
				<Sun
					className={cn(
						"absolute transition-[opacity,transform] duration-(--kn-dur) ease-(--kn-ease-out)",
						s.icon,
						isDark
							? "opacity-0 rotate-90 text-amber-400"
							: "opacity-100 rotate-0 text-amber-500",
					)}
				/>
				<Moon
					className={cn(
						"absolute transition-[opacity,transform] duration-(--kn-dur) ease-(--kn-ease-out)",
						s.icon,
						isDark
							? "opacity-100 rotate-0 text-slate-300"
							: "opacity-0 -rotate-90 text-slate-400",
					)}
				/>
			</span>
		</button>
	);
}
