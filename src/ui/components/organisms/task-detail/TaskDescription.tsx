import { useState, useEffect } from "react";
import { AlignLeft } from "lucide-react";
import { Button } from "../../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card";
import { MDEditor, MDRender } from "../../editor";
import type { Task } from "../../../models/task";

interface TaskDescriptionProps {
	task: Task;
	onSave: (updates: Partial<Task>) => Promise<void>;
	saving: boolean;
}

export function TaskDescription({ task, onSave, saving }: TaskDescriptionProps) {
	const [editing, setEditing] = useState(false);
	const [description, setDescription] = useState(task.description || "");

	useEffect(() => {
		setDescription(task.description || "");
	}, [task.description]);

	const handleSave = () => {
		if (description !== task.description) {
			onSave({ description: description || undefined });
		}
		setEditing(false);
	};

	const handleCancel = () => {
		setDescription(task.description || "");
		setEditing(false);
	};

	return (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="flex items-center gap-2 text-base">
					<AlignLeft className="w-4 h-4" />
					Description
				</CardTitle>
			</CardHeader>
			<CardContent>
				{editing ? (
					<div className="space-y-3">
						<MDEditor
							markdown={description}
							onChange={setDescription}
							placeholder="Add a more detailed description..."
							readOnly={saving}
						/>
						<div className="flex gap-2">
							<Button size="sm" onClick={handleSave} disabled={saving}>
								Save
							</Button>
							<Button size="sm" variant="ghost" onClick={handleCancel}>
								Cancel
							</Button>
						</div>
					</div>
				) : (
					<div
						className="min-h-[60px] p-3 rounded-md border border-dashed cursor-pointer hover:border-primary hover:bg-accent/50 transition-colors"
						onClick={() => setEditing(true)}
						role="button"
						tabIndex={0}
						onKeyDown={(e) => e.key === "Enter" && setEditing(true)}
					>
						{task.description ? (
							<MDRender markdown={task.description} className="text-sm" />
						) : (
							<span className="text-muted-foreground text-sm italic">
								Click to add description...
							</span>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
