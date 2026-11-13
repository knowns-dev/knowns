import type { Task } from "@/ui/models/task";
import { MarkdownField } from "./DetailSection";

interface TaskImplementationSectionProps {
	task: Task;
	onSave: (updates: Partial<Task>) => Promise<void>;
	saving: boolean;
	type: "plan" | "notes";
}

const sectionConfig = {
	plan: {
		title: "Implementation Plan",
		field: "implementationPlan" as const,
		placeholder: "1. First step\n2. Second step\n3. Third step...",
		emptyText: "Add an implementation plan",
	},
	notes: {
		title: "Implementation Notes",
		field: "implementationNotes" as const,
		placeholder: "Add implementation notes...",
		emptyText: "Add implementation notes",
	},
};

export function TaskImplementationSection({ task, onSave, saving, type }: TaskImplementationSectionProps) {
	const cfg = sectionConfig[type];
	return (
		<MarkdownField
			title={cfg.title}
			value={task[cfg.field] || ""}
			placeholder={cfg.placeholder}
			emptyText={cfg.emptyText}
			saving={saving}
			onSave={(next) => onSave({ [cfg.field]: next || undefined })}
		/>
	);
}
