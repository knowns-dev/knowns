import { useState, useRef, useEffect } from "react";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { Button } from "@/ui/components/ui/knowns/button";
import { Checkbox } from "@/ui/components/ui/knowns/checkbox";
import { Input } from "@/ui/components/ui/knowns/input";
import type { Task } from "@/ui/models/task";
import { cn, focusRing } from "@/ui/lib/knowns/utils";
import { ProgressReadout } from "@/ui/components/ui/knowns/blocks/task-detail";
import { DetailSection } from "./DetailSection";
import { moveItem } from "./types";

interface TaskAcceptanceCriteriaProps {
	task: Task;
	onSave: (updates: Partial<Task>) => Promise<void>;
	saving: boolean;
}

export function TaskAcceptanceCriteria({ task, onSave, saving }: TaskAcceptanceCriteriaProps) {
	const [adding, setAdding] = useState(false);
	const [newText, setNewText] = useState("");
	const [editingIndex, setEditingIndex] = useState<number | null>(null);
	const [editingText, setEditingText] = useState("");
	const [dragFrom, setDragFrom] = useState<number | null>(null);
	const [dragOver, setDragOver] = useState<number | null>(null);
	const [announce, setAnnounce] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const handleRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const focusAfterMove = useRef<number | null>(null);

	useEffect(() => {
		if (adding && inputRef.current) inputRef.current.focus();
	}, [adding]);

	const ac = task.acceptanceCriteria ?? [];
	const completedCount = ac.filter((a) => a.completed).length;
	const totalCount = ac.length;

	// After a keyboard move the list re-renders from the saved task; keep focus on the moved handle.
	useEffect(() => {
		if (focusAfterMove.current === null) return;
		handleRefs.current[focusAfterMove.current]?.focus();
		focusAfterMove.current = null;
	}, [task.acceptanceCriteria]);

	const handleToggle = (index: number) => {
		onSave({ acceptanceCriteria: ac.map((item, i) => (i === index ? { ...item, completed: !item.completed } : item)) });
	};

	const handleAdd = () => {
		if (!newText.trim()) return;
		onSave({ acceptanceCriteria: [...ac, { text: newText.trim(), completed: false }] });
		setNewText("");
		// Stay in add mode so several criteria can be typed in a row.
		inputRef.current?.focus();
	};

	const handleDelete = (index: number) => {
		onSave({ acceptanceCriteria: ac.filter((_, i) => i !== index) });
	};

	const handleMove = (from: number, to: number, viaKeyboard = false) => {
		const next = moveItem(ac, from, to);
		if (next === ac) return;
		const landed = Math.max(0, Math.min(ac.length - 1, to));
		if (viaKeyboard) focusAfterMove.current = landed;
		setAnnounce(`Moved "${ac[from]?.text ?? "criterion"}" to position ${landed + 1} of ${ac.length}`);
		onSave({ acceptanceCriteria: next });
	};

	const handleEditStart = (index: number) => {
		setEditingIndex(index);
		setEditingText(ac[index]?.text || "");
	};

	const handleEditSave = () => {
		if (editingIndex === null) return;
		const current = ac[editingIndex];
		if (current && editingText.trim() && editingText !== current.text) {
			onSave({ acceptanceCriteria: ac.map((item, i) => (i === editingIndex ? { ...item, text: editingText.trim() } : item)) });
		}
		setEditingIndex(null);
		setEditingText("");
	};

	return (
		<DetailSection title="Acceptance Criteria" count={totalCount > 0 ? `${completedCount}/${totalCount}` : undefined}>
			<div role="status" aria-live="polite" className="sr-only">
				{announce}
			</div>
			{totalCount > 0 && <ProgressReadout value={completedCount} total={totalCount} unit="criteria" label="Acceptance criteria done" />}
			{totalCount > 0 && (
				<ul aria-label="Acceptance criteria" className="-mx-2 flex flex-col">
					{ac.map((item, index) => (
						<li
							key={`${index}-${item.text}`}
							onDragOver={(e) => {
								if (dragFrom === null) return;
								e.preventDefault();
								e.dataTransfer.dropEffect = "move";
								if (dragOver !== index) setDragOver(index);
							}}
							onDrop={(e) => {
								e.preventDefault();
								if (dragFrom !== null) handleMove(dragFrom, index);
								setDragFrom(null);
								setDragOver(null);
							}}
							className={cn(
								"group/ac relative flex items-start gap-1.5 rounded-lg py-1.5 pr-1 pl-0.5 sm:pl-2 transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--foreground)_3%,transparent)]",
								dragFrom === index && "opacity-50",
								dragOver === index && dragFrom !== null && dragFrom !== index && "bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)]",
							)}
						>
							{dragOver === index && dragFrom !== null && dragFrom !== index && (
								<span
									aria-hidden
									className={cn("absolute inset-x-2 h-0.5 rounded-full bg-[color:var(--kn-accent,var(--primary))]", dragFrom < index ? "-bottom-px" : "-top-px")}
								/>
							)}
							<button
								ref={(el) => {
									handleRefs.current[index] = el;
								}}
								type="button"
								draggable={!saving}
								onDragStart={(e) => {
									setDragFrom(index);
									e.dataTransfer.effectAllowed = "move";
									e.dataTransfer.setData("text/plain", item.text);
								}}
								onDragEnd={() => {
									setDragFrom(null);
									setDragOver(null);
								}}
								onKeyDown={(e) => {
									if (e.key === "ArrowUp" || e.key === "ArrowDown") {
										e.preventDefault();
										handleMove(index, index + (e.key === "ArrowUp" ? -1 : 1), true);
									}
								}}
								disabled={saving || totalCount < 2}
								aria-label={`Reorder "${item.text}", position ${index + 1} of ${totalCount}. Use arrow keys to move.`}
								title="Drag or use arrow keys to reorder"
								className={cn(
									"mt-px grid size-5 flex-none cursor-grab sm:absolute sm:top-2 sm:-left-6 place-items-center rounded-[5px] text-muted-foreground/70 transition-opacity duration-150 hover:text-foreground active:cursor-grabbing disabled:invisible",
									"opacity-100 sm:opacity-0 sm:group-hover/ac:opacity-100 sm:focus-visible:opacity-100",
									focusRing,
								)}
							>
								<GripVertical className="size-3.5" aria-hidden />
							</button>
							<Checkbox
								checked={item.completed}
								onChange={() => handleToggle(index)}
								disabled={saving}
								aria-label={item.text}
								className="mt-0.5"
							/>
							{editingIndex === index ? (
								<Input
									size="sm"
									value={editingText}
									onChange={(e) => setEditingText(e.target.value)}
									onBlur={handleEditSave}
									onKeyDown={(e) => {
										if (e.key === "Enter") handleEditSave();
										if (e.key === "Escape") {
											e.stopPropagation();
											setEditingIndex(null);
											setEditingText("");
										}
									}}
									aria-label="Edit criterion"
									className="-my-1 ml-1 flex-1"
									autoFocus
								/>
							) : (
								<button
									type="button"
									onClick={() => handleEditStart(index)}
									className={cn(
										"ml-1 min-w-0 flex-1 cursor-text rounded-[5px] text-left text-[14px] leading-snug break-words",
										item.completed ? "text-muted-foreground line-through decoration-muted-foreground/50" : "text-foreground",
										focusRing,
									)}
								>
									{item.text}
								</button>
							)}
							<Button
								size="xs"
								variant="ghost"
								icon={<Trash2 />}
								aria-label={`Remove "${item.text}"`}
								className="flex-none text-muted-foreground opacity-100 hover:text-red-600 sm:opacity-0 sm:group-hover/ac:opacity-100 sm:focus-visible:opacity-100 dark:hover:text-red-400"
								onClick={() => handleDelete(index)}
								disabled={saving}
							/>
						</li>
					))}
				</ul>
			)}

			{adding ? (
				<div className="flex flex-col gap-2 pt-1">
					<Input
						ref={inputRef}
						value={newText}
						onChange={(e) => setNewText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && newText.trim()) handleAdd();
							if (e.key === "Escape") {
								e.stopPropagation();
								setNewText("");
								setAdding(false);
							}
						}}
						placeholder="Add acceptance criterion..."
						aria-label="New acceptance criterion"
					/>
					<div className="flex gap-2">
						<Button size="sm" onClick={handleAdd} disabled={!newText.trim()}>
							Add
						</Button>
						<Button
							size="sm"
							variant="ghost"
							onClick={() => {
								setNewText("");
								setAdding(false);
							}}
						>
							Done
						</Button>
					</div>
				</div>
			) : (
				<button
					type="button"
					className={cn(
						"-mx-2 flex items-center gap-2 self-start rounded-lg px-2 py-1.5 text-[13.5px] text-muted-foreground transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] hover:text-foreground",
						focusRing,
					)}
					onClick={() => setAdding(true)}
				>
					<Plus className="size-4" aria-hidden />
					Add criterion
				</button>
			)}
		</DetailSection>
	);
}
