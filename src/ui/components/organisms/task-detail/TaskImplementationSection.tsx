import { useState, useEffect } from "react";
import { FileText, Pencil } from "lucide-react";
import { Button } from "../../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card";
import { MDEditor, MDRender } from "../../editor";
import type { Task } from "../../../models/task";

interface TaskImplementationSectionProps {
	task: Task;
	onSave: (updates: Partial<Task>) => Promise<void>;
	saving: boolean;
	type: "plan" | "notes";
}

const config = {
	plan: {
		title: "Implementation Plan",
		icon: FileText,
		field: "implementationPlan" as const,
		placeholder: "1. First step\n2. Second step\n3. Third step...",
		emptyText: "Click to add implementation plan...",
	},
	notes: {
		title: "Implementation Notes",
		icon: Pencil,
		field: "implementationNotes" as const,
		placeholder: "Add implementation notes...",
		emptyText: "Click to add notes...",
	},
};

export function TaskImplementationSection({
	task,
	onSave,
	saving,
	type,
}: TaskImplementationSectionProps) {
	const cfg = config[type];
	const Icon = cfg.icon;
	const fieldValue = task[cfg.field] || "";

	const [editing, setEditing] = useState(false);
	const [content, setContent] = useState(fieldValue);

	useEffect(() => {
		setContent(fieldValue);
	}, [fieldValue]);

	const handleSave = () => {
		if (content !== fieldValue) {
			onSave({ [cfg.field]: content || undefined });
		}
		setEditing(false);
	};

	const handleCancel = () => {
		setContent(fieldValue);
		setEditing(false);
	};

	return (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="flex items-center gap-2 text-base">
					<Icon className="w-4 h-4" />
					{cfg.title}
				</CardTitle>
			</CardHeader>
			<CardContent>
				{editing ? (
					<div className="space-y-3">
						<MDEditor
							markdown={content}
							onChange={setContent}
							placeholder={cfg.placeholder}
							readOnly={saving}
							height={200}
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
						{fieldValue ? (
							<MDRender markdown={fieldValue} className="text-sm prose prose-sm dark:prose-invert max-w-none" />
						) : (
							<span className="text-muted-foreground text-sm italic">{cfg.emptyText}</span>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
