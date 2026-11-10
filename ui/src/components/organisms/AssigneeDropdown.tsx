import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronsUpDown, Hand, Search, User, UserX } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Button } from "../ui/button";
import Avatar from "../atoms/Avatar";
import { cn } from "@/ui/lib/utils";

interface AssigneeDropdownProps {
	value: string;
	onChange: (value: string) => void;
	currentUser?: string;
	showGrabButton?: boolean;
	placeholder?: string;
	className?: string;
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

const asHandle = (s: string) => (s.startsWith("@") ? s : `@${s}`);

interface Row {
	id: string;
	group: "Actions" | "Recent" | "Add New";
	label: ReactNode;
	icon: ReactNode;
	selected?: boolean;
	run: () => void;
}

/**
 * Assignee picker: a search field over quick actions (grab, unassign), recent assignees and "add" for a new
 * handle. A Knowns UI popover (portals into an open dialog, so it works in the task sheet and create form) with
 * a listbox driven from the search field (arrow keys, Enter, Escape).
 */
export default function AssigneeDropdown({
	value,
	onChange,
	currentUser = "@me",
	showGrabButton = true,
	placeholder = "Select assignee...",
	className = "",
}: AssigneeDropdownProps) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [recentAssignees, setRecentAssignees] = useState<string[]>([]);
	const [active, setActive] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);
	const baseId = useId();

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

	const rows = useMemo<Row[]>(() => {
		const out: Row[] = [];
		const query = search.trim().toLowerCase();
		if (showGrabButton && value !== currentUser && (!query || `grab task ${currentUser}`.toLowerCase().includes(query)))
			out.push({ id: "grab", group: "Actions", label: `Grab task (${currentUser})`, icon: <Hand />, run: () => handleSelect(currentUser) });
		if (value && (!query || "unassign".includes(query)))
			out.push({ id: "unassign", group: "Actions", label: "Unassign", icon: <UserX />, run: () => handleSelect("") });
		for (const a of recentAssignees) {
			if (query && !a.toLowerCase().includes(query)) continue;
			out.push({
				id: `recent:${a}`,
				group: "Recent",
				label: a,
				icon: <Avatar name={a} size="sm" />,
				selected: value === a,
				run: () => handleSelect(a),
			});
		}
		const typed = search.trim();
		if (typed && !recentAssignees.some((a) => a.toLowerCase() === asHandle(typed).toLowerCase()))
			out.push({ id: "add", group: "Add New", label: `Add "${asHandle(typed)}"`, icon: <User />, run: () => handleSelect(asHandle(typed)) });
		return out;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [search, recentAssignees, value, currentUser, showGrabButton]);

	// Highlight the first row whenever the list changes or it opens.
	useEffect(() => setActive(0), [search, open]);

	// Keep the highlighted row in view.
	useEffect(() => {
		listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
	}, [active]);

	const optionId = (i: number) => `${baseId}-opt-${i}`;
	const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			if (!rows.length) return;
			const dir = e.key === "ArrowDown" ? 1 : -1;
			setActive((i) => (i + dir + rows.length) % rows.length);
		} else if (e.key === "Home" && rows.length) {
			e.preventDefault();
			setActive(0);
		} else if (e.key === "End" && rows.length) {
			e.preventDefault();
			setActive(rows.length - 1);
		} else if (e.key === "Enter") {
			e.preventDefault();
			rows[active]?.run();
		}
	};

	let lastGroup: Row["group"] | null = null;

	return (
		<div className={`flex items-center gap-2 ${className}`}>
			<Popover
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					if (!next) setSearch("");
				}}
			>
				<PopoverTrigger asChild>
					<Button
						variant="outline"
						role="combobox"
						aria-expanded={open}
						aria-haspopup="listbox"
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
				<PopoverContent className="flex w-[250px] flex-col overflow-hidden p-0" align="start">
					<div className="flex flex-none items-center gap-2 border-b px-3">
						<Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
						<input
							autoFocus
							role="combobox"
							aria-label="Search assignee"
							aria-expanded
							aria-controls={`${baseId}-list`}
							aria-autocomplete="list"
							aria-activedescendant={rows.length ? optionId(active) : undefined}
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							onKeyDown={onSearchKey}
							placeholder="Search assignee..."
							autoComplete="off"
							spellCheck={false}
							className="h-9 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
						/>
					</div>
					<div
						ref={listRef}
						id={`${baseId}-list`}
						role="listbox"
						aria-label="Assignees"
						className="max-h-72 overflow-y-auto overscroll-contain p-1"
					>
						{rows.length === 0 && <div className="px-2.5 py-6 text-center text-[12.5px] text-muted-foreground">No assignees found.</div>}
						{rows.map((row, i) => {
							const heading = row.group !== lastGroup ? row.group : null;
							lastGroup = row.group;
							return (
								<div key={row.id}>
									{heading && (
										<>
											{i > 0 && <div aria-hidden className="mx-1.5 my-1 h-px bg-border" />}
											<div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">{heading}</div>
										</>
									)}
									<div
										id={optionId(i)}
										data-index={i}
										role="option"
										aria-selected={row.selected ?? false}
										onPointerMove={() => active !== i && setActive(i)}
										onMouseDown={(e) => e.preventDefault()}
										onClick={row.run}
										className={cn(
											"flex min-h-8 cursor-pointer select-none items-center gap-2.5 rounded-[8px] px-2.5 py-1.5 text-[13px] [&_svg]:size-4 [&_svg]:shrink-0",
											i === active && "bg-muted",
										)}
									>
										<span className="grid size-5 shrink-0 place-items-center text-muted-foreground">{row.icon}</span>
										<span className="min-w-0 flex-1 truncate">{row.label}</span>
										{row.selected && <Check className="text-foreground" aria-hidden />}
									</div>
								</div>
							);
						})}
					</div>
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
