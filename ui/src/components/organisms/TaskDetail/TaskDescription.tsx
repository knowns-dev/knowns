import type { Task } from "@/ui/models/task";
import { MarkdownField } from "./DetailSection";

interface TaskDescriptionProps {
	task: Task;
	onSave: (updates: Partial<Task>) => Promise<void>;
	saving: boolean;
}

export function TaskDescription({ task, onSave, saving }: TaskDescriptionProps) {
	return (
		<MarkdownField
			title="Description"
			value={task.description || ""}
			placeholder="Add a more detailed description..."
			emptyText="Add a description"
			saving={saving}
			onSave={(next) => onSave({ description: next || undefined })}
		/>
	);
}
