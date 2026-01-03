import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import { Eye, RefreshCw, Trash2, ExternalLink, ClipboardCheck, FileText, Loader2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { Button } from "../../ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "../../ui/command";
import { search, getTasks, getDocs, type Doc } from "../../../api/client";
import type { Task } from "../../../../models/task";

interface MentionToolbarProps {
	children: ReactNode;
	isEditable: boolean;
	onPreview: () => void;
	onReplace: (type: "task" | "doc", id: string) => void;
	onDelete: () => void;
	previewContent?: ReactNode;
	type: "task" | "doc";
}

// Status colors for task items
const STATUS_COLORS: Record<string, string> = {
	todo: "bg-muted-foreground/50",
	"in-progress": "bg-yellow-500",
	"in-review": "bg-purple-500",
	blocked: "bg-destructive",
	done: "bg-green-500",
};

/**
 * Hover toolbar for mention badges in edit mode
 * Shows Preview, Replace, Delete buttons with shadcn/ui styling
 */
export function MentionToolbar({
	children,
	isEditable,
	onPreview,
	onReplace,
	onDelete,
	previewContent,
	type,
}: MentionToolbarProps) {
	const [isOpen, setIsOpen] = useState(false);
	const [showPreview, setShowPreview] = useState(false);
	const [showReplace, setShowReplace] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [tasks, setTasks] = useState<Task[]>([]);
	const [docs, setDocs] = useState<Doc[]>([]);
	const [loading, setLoading] = useState(false);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isHoveringRef = useRef(false);

	// Load initial items
	const loadInitialItems = useCallback(async () => {
		setLoading(true);
		try {
			if (type === "task") {
				const fetchedTasks = await getTasks();
				setTasks(fetchedTasks.slice(0, 10));
			} else {
				const fetchedDocs = await getDocs();
				setDocs(fetchedDocs.slice(0, 10));
			}
		} catch (error) {
			console.error("Failed to load items:", error);
		} finally {
			setLoading(false);
		}
	}, [type]);

	// Search items
	const searchItems = useCallback(async (query: string) => {
		if (!query.trim()) {
			loadInitialItems();
			return;
		}

		setLoading(true);
		try {
			const results = await search(query);
			if (type === "task") {
				setTasks(results.tasks.slice(0, 10));
			} else {
				setDocs((results.docs as Doc[]).slice(0, 10));
			}
		} catch (error) {
			console.error("Failed to search:", error);
		} finally {
			setLoading(false);
		}
	}, [type, loadInitialItems]);

	// Debounced search
	useEffect(() => {
		if (!showReplace) return;

		if (searchTimeoutRef.current) {
			clearTimeout(searchTimeoutRef.current);
		}

		searchTimeoutRef.current = setTimeout(() => {
			searchItems(searchQuery);
		}, 300);

		return () => {
			if (searchTimeoutRef.current) {
				clearTimeout(searchTimeoutRef.current);
			}
		};
	}, [searchQuery, showReplace, searchItems]);

	// Load items when replace panel opens
	useEffect(() => {
		if (showReplace) {
			loadInitialItems();
		}
	}, [showReplace, loadInitialItems]);

	const handleMouseEnter = () => {
		if (!isEditable) return;
		isHoveringRef.current = true;

		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
		}

		timeoutRef.current = setTimeout(() => {
			if (isHoveringRef.current) {
				setIsOpen(true);
			}
		}, 300);
	};

	const handleMouseLeave = () => {
		isHoveringRef.current = false;

		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
		}

		// Don't auto-close if replace panel is open
		if (showReplace) return;

		timeoutRef.current = setTimeout(() => {
			if (!isHoveringRef.current) {
				setIsOpen(false);
				setShowPreview(false);
			}
		}, 200);
	};

	const handleContentMouseEnter = () => {
		isHoveringRef.current = true;
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
		}
	};

	const handleContentMouseLeave = () => {
		// Don't auto-close if replace panel is open
		if (showReplace) return;
		handleMouseLeave();
	};

	useEffect(() => {
		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}
			if (searchTimeoutRef.current) {
				clearTimeout(searchTimeoutRef.current);
			}
		};
	}, []);

	const handlePreviewClick = (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setShowPreview(!showPreview);
		setShowReplace(false);
	};

	const handleReplaceClick = (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setShowReplace(!showReplace);
		setShowPreview(false);
		setSearchQuery("");
	};

	const handleSelectItem = (itemType: "task" | "doc", id: string) => {
		setIsOpen(false);
		setShowReplace(false);
		setSearchQuery("");
		onReplace(itemType, id);
	};

	const handleDeleteClick = (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsOpen(false);
		onDelete();
	};

	const handleNavigate = (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsOpen(false);
		onPreview();
	};

	const handleClose = () => {
		setIsOpen(false);
		setShowPreview(false);
		setShowReplace(false);
		setSearchQuery("");
	};

	// If not editable, just render children
	if (!isEditable) {
		return <>{children}</>;
	}

	return (
		<Popover open={isOpen} onOpenChange={(open) => {
			if (!open) handleClose();
			else setIsOpen(true);
		}} modal={false}>
			<PopoverTrigger asChild onClick={(e) => e.preventDefault()}>
				<span
					onMouseEnter={handleMouseEnter}
					onMouseLeave={handleMouseLeave}
				>
					{children}
				</span>
			</PopoverTrigger>
			<PopoverContent
				className="w-auto p-0"
				side="top"
				align="center"
				sideOffset={4}
				onMouseEnter={handleContentMouseEnter}
				onMouseLeave={handleContentMouseLeave}
				onOpenAutoFocus={(e) => e.preventDefault()}
			>
				<div className="flex flex-col">
					{/* Toolbar buttons */}
					<div className="flex items-center gap-0.5 p-1 border-b border-border">
						<Button
							variant={showPreview ? "secondary" : "ghost"}
							size="sm"
							className="h-7 px-2 text-xs gap-1.5"
							onClick={handlePreviewClick}
						>
							<Eye className="w-3.5 h-3.5" />
							<span className="hidden sm:inline">Preview</span>
						</Button>
						<Button
							variant={showReplace ? "secondary" : "ghost"}
							size="sm"
							className="h-7 px-2 text-xs gap-1.5"
							onClick={handleReplaceClick}
						>
							<RefreshCw className="w-3.5 h-3.5" />
							<span className="hidden sm:inline">Replace</span>
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className="h-7 px-2 text-xs gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10"
							onClick={handleDeleteClick}
						>
							<Trash2 className="w-3.5 h-3.5" />
							<span className="hidden sm:inline">Delete</span>
						</Button>
						<div className="w-px h-4 bg-border mx-1" />
						<Button
							variant="ghost"
							size="sm"
							className="h-7 px-2 text-xs gap-1.5"
							onClick={handleNavigate}
						>
							<ExternalLink className="w-3.5 h-3.5" />
							<span className="hidden sm:inline">Open</span>
						</Button>
					</div>

					{/* Preview content */}
					{showPreview && previewContent && (
						<div className="p-2 border-b border-border">
							<div className="text-xs font-medium text-muted-foreground mb-1.5">Preview</div>
							<div className="max-h-28 overflow-auto text-sm">
								{previewContent}
							</div>
						</div>
					)}

					{/* Replace panel with Command */}
					{showReplace && (
						<Command className="w-full min-w-56" shouldFilter={false}>
							<div className="relative">
								<CommandInput
									placeholder={`Search ${type === "task" ? "tasks" : "docs"}...`}
									value={searchQuery}
									onValueChange={setSearchQuery}
									onMouseDown={(e) => e.stopPropagation()}
									className="h-8 text-sm"
								/>
								{loading && (
									<Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 animate-spin text-muted-foreground" />
								)}
							</div>
							<CommandList className="max-h-48">
								<CommandEmpty className="py-3 text-xs">
									{loading ? "Searching..." : `No ${type === "task" ? "tasks" : "docs"} found`}
								</CommandEmpty>
								{type === "task" ? (
									<CommandGroup heading="Tasks" className="[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:py-1">
										{tasks.map((task) => (
											<CommandItem
												key={task.id}
												value={`task-${task.id}`}
												onSelect={() => handleSelectItem("task", `task-${task.id}`)}
												onMouseDown={(e) => e.stopPropagation()}
												className="cursor-pointer py-1.5 text-sm gap-2"
											>
												<ClipboardCheck className="w-3.5 h-3.5 shrink-0 text-green-600 dark:text-green-400" />
												<span className="text-muted-foreground text-xs shrink-0">#{task.id}</span>
												<span className="truncate flex-1">{task.title}</span>
												<span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_COLORS[task.status] || "bg-muted-foreground/50"}`} />
											</CommandItem>
										))}
									</CommandGroup>
								) : (
									<CommandGroup heading="Docs" className="[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:py-1">
										{docs.map((doc) => (
											<CommandItem
												key={doc.path}
												value={doc.path}
												onSelect={() => handleSelectItem("doc", doc.path.replace(/\.md$/, ""))}
												onMouseDown={(e) => e.stopPropagation()}
												className="cursor-pointer py-1.5 text-sm gap-2"
											>
												<FileText className="w-3.5 h-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
												<span className="truncate flex-1">{doc.title || doc.path}</span>
											</CommandItem>
										))}
									</CommandGroup>
								)}
							</CommandList>
						</Command>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}

export default MentionToolbar;
