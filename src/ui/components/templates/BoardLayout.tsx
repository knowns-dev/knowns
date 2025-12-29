import type { ReactNode } from "react";
import { cn } from "@/ui/lib/utils";

interface BoardLayoutProps {
	title?: string;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
}

export function BoardLayout({ title, actions, children, className }: BoardLayoutProps) {
	return (
		<div className={cn("h-full flex flex-col", className)}>
			{(title || actions) && (
				<div className="flex items-center justify-between px-6 py-4 border-b">
					{title && <h1 className="text-xl font-semibold">{title}</h1>}
					{actions && <div className="flex items-center gap-2">{actions}</div>}
				</div>
			)}
			<div className="flex-1 overflow-auto">{children}</div>
		</div>
	);
}
