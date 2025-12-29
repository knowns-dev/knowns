import { useState, useEffect, useMemo } from "react";
import { Check, ChevronsUpDown, User, UserX, Hand } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "../ui/command";
import { Button } from "../ui/button";
import Avatar from "../atoms/Avatar";

interface AssigneeDropdownProps {
	value: string;
	onChange: (value: string) => void;
	currentUser?: string;
	showGrabButton?: boolean;
	placeholder?: string;
	className?: string;
	container?: HTMLElement | null;
}

const RECENT_ASSIGNEES_KEY = "knowns-recent-assignees";
const MAX_RECENT = 10;

// Get recent assignees from localStorage
function getRecentAssignees(): string[] {
	try {
		const stored = localStorage.getItem(RECENT_ASSIGNEES_KEY);
		return stored ? JSON.parse(stored) : [];
	} catch {
		return [];
	}
}

// Save assignee to recent list
function saveRecentAssignee(assignee: string) {
	if (!assignee) return;
	try {
		const recent = getRecentAssignees().filter((a) => a !== assignee);
		recent.unshift(assignee);
		localStorage.setItem(RECENT_ASSIGNEES_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
	} catch {
		// Ignore localStorage errors
	}
}

export default function AssigneeDropdown({
	value,
	onChange,
	currentUser = "@me",
	showGrabButton = true,
	placeholder = "Select assignee...",
	className = "",
	container,
}: AssigneeDropdownProps) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [recentAssignees, setRecentAssignees] = useState<string[]>([]);

	useEffect(() => {
		setRecentAssignees(getRecentAssignees());
	}, []);

	const handleSelect = (assignee: string) => {
		onChange(assignee);
		if (assignee) {
			saveRecentAssignee(assignee);
			setRecentAssignees(getRecentAssignees());
		}
		setOpen(false);
		setSearch("");
	};

	const handleGrab = () => {
		handleSelect(currentUser);
	};

	const handleUnassign = () => {
		handleSelect("");
	};

	// Filter recent assignees based on search
	const filteredRecent = useMemo(() => {
		if (!search) return recentAssignees;
		const query = search.toLowerCase();
		return recentAssignees.filter((a) => a.toLowerCase().includes(query));
	}, [recentAssignees, search]);

	// Check if search term is a new assignee
	const isNewAssignee = useMemo(() => {
		if (!search) return false;
		const normalized = search.startsWith("@") ? search : `@${search}`;
		return !recentAssignees.some((a) => a.toLowerCase() === normalized.toLowerCase());
	}, [search, recentAssignees]);

	return (
		<div className={`flex items-center gap-2 ${className}`}>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<Button
						variant="outline"
						role="combobox"
						aria-expanded={open}
						className="flex-1 justify-between min-w-0 overflow-hidden"
					>
						<div className="flex items-center gap-2 min-w-0 flex-1">
							{value ? (
								<>
									<Avatar name={value} size="sm" className="shrink-0" />
									<span className="truncate">{value}</span>
								</>
							) : (
								<>
									<User className="w-4 h-4 opacity-50 shrink-0" />
									<span className="opacity-50 truncate">{placeholder}</span>
								</>
							)}
						</div>
						<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
					</Button>
				</PopoverTrigger>
				<PopoverContent className="w-[250px] p-0" align="start" container={container}>
					<Command>
						<CommandInput
							placeholder="Search assignee..."
							value={search}
							onValueChange={setSearch}
						/>
						<CommandList>
							<CommandEmpty>
								{search ? (
									<button
										type="button"
										className="w-full px-2 py-3 text-left text-sm hover:bg-accent"
										onClick={() => handleSelect(search.startsWith("@") ? search : `@${search}`)}
									>
										Add "{search.startsWith("@") ? search : `@${search}`}"
									</button>
								) : (
									"No assignees found."
								)}
							</CommandEmpty>

							{/* Quick Actions */}
							<CommandGroup heading="Actions">
								{showGrabButton && value !== currentUser && (
									<CommandItem onSelect={handleGrab}>
										<Hand className="mr-2 h-4 w-4" />
										Grab task ({currentUser})
									</CommandItem>
								)}
								{value && (
									<CommandItem onSelect={handleUnassign}>
										<UserX className="mr-2 h-4 w-4" />
										Unassign
									</CommandItem>
								)}
							</CommandGroup>

							{filteredRecent.length > 0 && (
								<>
									<CommandSeparator />
									<CommandGroup heading="Recent">
										{filteredRecent.map((assignee) => (
											<CommandItem
												key={assignee}
												value={assignee}
												onSelect={() => handleSelect(assignee)}
											>
												<Avatar name={assignee} size="sm" className="mr-2" />
												<span className="flex-1">{assignee}</span>
												{value === assignee && <Check className="h-4 w-4" />}
											</CommandItem>
										))}
									</CommandGroup>
								</>
							)}

							{/* Add new assignee from search */}
							{isNewAssignee && search && (
								<>
									<CommandSeparator />
									<CommandGroup heading="Add New">
										<CommandItem
											onSelect={() =>
												handleSelect(search.startsWith("@") ? search : `@${search}`)
											}
										>
											<User className="mr-2 h-4 w-4" />
											Add "{search.startsWith("@") ? search : `@${search}`}"
										</CommandItem>
									</CommandGroup>
								</>
							)}
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>

			{/* Quick Grab Button */}
			{showGrabButton && value !== currentUser && (
				<Button
					variant="outline"
					size="icon"
					onClick={handleGrab}
					title="Grab task"
					className="shrink-0"
				>
					<Hand className="h-4 w-4" />
				</Button>
			)}
		</div>
	);
}
