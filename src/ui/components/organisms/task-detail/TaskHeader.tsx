import { useState, useRef, useEffect } from "react";
import { SheetHeader, SheetTitle } from "../../ui/sheet";
import { Input } from "../../ui/input";
import { Badge } from "../../ui/badge";
import type { Task } from "../../../models/task";
import { statusColors } from "./types";

interface TaskHeaderProps {
	task: Task;
	onSave: (updates: Partial<Task>) => Promise<void>;
	saving: boolean;
}

export function TaskHeader({ task, onSave, saving }: TaskHeaderProps) {
	const [editing, setEditing] = useState(false);
	const [title, setTitle] = useState(task.title);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		setTitle(task.title);
	}, [task.title]);

	useEffect(() => {
		if (editing && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [editing]);

	const handleSave = () => {
		if (title.trim() && title !== task.title) {
			onSave({ title: title.trim() });
		}
		setEditing(false);
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") handleSave();
		if (e.key === "Escape") {
			setTitle(task.title);
			setEditing(false);
		}
	};

	return (
		<SheetHeader className="space-y-3 pb-4 border-b">
			<div className="flex items-center gap-2">
				<Badge variant="outline" className="font-mono">
					#{task.id}
				</Badge>
				<Badge className={statusColors[task.status]}>
					{task.status.replace("-", " ").replace(/\b\w/g, (l) => l.toUpperCase())}
				</Badge>
			</div>
			{editing ? (
				<Input
					ref={inputRef}
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					onBlur={handleSave}
					onKeyDown={handleKeyDown}
					disabled={saving}
					className="text-xl font-semibold"
				/>
			) : (
				<SheetTitle
					className="text-xl cursor-pointer hover:text-primary transition-colors text-left"
					onClick={() => setEditing(true)}
				>
					{task.title}
				</SheetTitle>
			)}
		</SheetHeader>
	);
}
