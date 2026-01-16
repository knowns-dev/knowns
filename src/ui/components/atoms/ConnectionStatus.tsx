import { useSSE } from "../../contexts/SSEContext";
import { cn } from "@/ui/lib/utils";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "../ui/tooltip";

interface ConnectionStatusProps {
	className?: string;
}

/**
 * Connection status indicator for SSE connection
 * - Hidden when connected (no visual noise)
 * - Shows red/amber indicator when disconnected with reconnection animation
 */
export function ConnectionStatus({ className }: ConnectionStatusProps) {
	const { isConnected } = useSSE();

	// Don't render when connected (no visual noise when everything works)
	if (isConnected) {
		return null;
	}

	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<div
						className={cn(
							"flex items-center gap-1.5 px-2 py-1 rounded-md",
							"bg-amber-500/10 text-amber-600 dark:text-amber-400",
							"animate-in fade-in slide-in-from-left-2 duration-200",
							className
						)}
						role="status"
						aria-live="polite"
						aria-label="Connection lost - attempting to reconnect"
					>
						{/* Animated disconnection indicator */}
						<span className="relative flex h-2 w-2">
							<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
							<span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
						</span>
						<span className="text-xs font-medium">Reconnecting...</span>
					</div>
				</TooltipTrigger>
				<TooltipContent side="bottom">
					<p>Connection lost - attempting to reconnect</p>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
