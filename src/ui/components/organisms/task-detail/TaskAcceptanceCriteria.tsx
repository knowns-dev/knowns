import { useState, useRef, useEffect } from "react";
import { ClipboardCheck, Plus, Trash2 } from "lucide-react";
import { Button } from "../../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { Progress } from "../../ui/progress";
import type { Task } from "../../../models/task";
import { cn } from "@/ui/lib/utils";

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
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (adding && inputRef.current) inputRef.current.focus();
	}, [adding]);

	const completedCount = task.acceptanceCriteria.filter((ac) => ac.completed).length;
	const totalCount = task.acceptanceCriteria.length;
	const progress = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

	const handleToggle = (index: number) => {
		const newAC = task.acceptanceCriteria.map((ac, i) =>
			i === index ? { ...ac, completed: !ac.completed } : ac
		);
		onSave({ acceptanceCriteria: newAC });
	};

	const handleAdd = () => {
		if (!newText.trim()) return;
		onSave({
			acceptanceCriteria: [
				...task.acceptanceCriteria,
				{ text: newText.trim(), completed: false },
			],
		});
		setNewText("");
		setAdding(false);
	};

	const handleDelete = (index: number) => {
		onSave({
			acceptanceCriteria: task.acceptanceCriteria.filter((_, i) => i !== index),
		});
	};

	const handleEditStart = (index: number) => {
		setEditingIndex(index);
		setEditingText(task.acceptanceCriteria[index]?.text || "");
	};

	const handleEditSave = () => {
		if (editingIndex === null) return;
		const currentAC = task.acceptanceCriteria[editingIndex];
		if (currentAC && editingText.trim() && editingText !== currentAC.text) {
			onSave({
				acceptanceCriteria: task.acceptanceCriteria.map((ac, i) =>
					i === editingIndex ? { ...ac, text: editingText.trim() } : ac
				),
			});
		}
		setEditingIndex(null);
		setEditingText("");
	};

	return (
		<Card>
			<CardHeader className="pb-3">
				<div className="flex items-center justify-between">
					<CardTitle className="flex items-center gap-2 text-base">
						<ClipboardCheck className="w-4 h-4" />
						Acceptance Criteria
						{totalCount > 0 && (
							<span className="text-muted-foreground font-normal">
								({completedCount}/{totalCount})
							</span>
						)}
					</CardTitle>
				</div>
				{totalCount > 0 && (
					<div className="flex items-center gap-2 pt-2">
						<span className="text-xs text-muted-foreground w-8">{Math.round(progress)}%</span>
						<Progress value={progress} className="flex-1 h-2" />
					</div>
				)}
			</CardHeader>
			<CardContent className="space-y-2">
				{task.acceptanceCriteria.map((ac, index) => (
					<div
						key={index}
						className="flex items-start gap-3 p-2 rounded-md hover:bg-accent group"
					>
						<Checkbox
							checked={ac.completed}
							onCheckedChange={() => handleToggle(index)}
							disabled={saving}
							className="mt-0.5"
						/>
						{editingIndex === index ? (
							<Input
								value={editingText}
								onChange={(e) => setEditingText(e.target.value)}
								onBlur={handleEditSave}
								onKeyDown={(e) => {
									if (e.key === "Enter") handleEditSave();
									if (e.key === "Escape") {
										setEditingIndex(null);
										setEditingText("");
									}
								}}
								className="flex-1 h-8"
								autoFocus
							/>
						) : (
							<span
								className={cn(
									"flex-1 text-sm cursor-pointer",
									ac.completed && "line-through text-muted-foreground"
								)}
								onClick={() => handleEditStart(index)}
							>
								{ac.text}
							</span>
						)}
						<Button
							variant="ghost"
							size="icon"
							className="h-6 w-6 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
							onClick={() => handleDelete(index)}
						>
							<Trash2 className="w-3 h-3" />
						</Button>
					</div>
				))}

				{adding ? (
					<div className="p-2 space-y-2">
						<Input
							ref={inputRef}
							value={newText}
							onChange={(e) => setNewText(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && newText.trim()) handleAdd();
								if (e.key === "Escape") {
									setNewText("");
									setAdding(false);
								}
							}}
							placeholder="Add acceptance criterion..."
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
								Cancel
							</Button>
						</div>
					</div>
				) : (
					<Button
						variant="ghost"
						size="sm"
						className="w-full justify-start text-muted-foreground"
						onClick={() => setAdding(true)}
					>
						<Plus className="w-4 h-4 mr-2" />
						Add criterion
					</Button>
				)}
			</CardContent>
		</Card>
	);
}
