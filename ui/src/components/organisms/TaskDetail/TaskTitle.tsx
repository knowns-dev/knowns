import { useState, useRef, useEffect } from "react";
import type { Task } from "@/ui/models/task";
import { cn, focusRing } from "@/ui/lib/knowns/utils";

interface TaskTitleProps {
	task: Task;
	onSave: (updates: Partial<Task>) => Promise<void>;
	saving: boolean;
}

/**
 * The task title for the page header's <h1>: plain text that turns into a matching input on click,
 * Enter saves, Escape restores.
 */
export function TaskTitle({ task, onSave, saving }: TaskTitleProps) {
	const [editing, setEditing] = useState(false);
	const [title, setTitle] = useState(task.title);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		setTitle(task.title);
	}, [task.title]);

	useEffect(() => {
		const el = inputRef.current;
		if (editing && el) {
			el.focus();
			el.select();
		}
	}, [editing]);

	// Grow the field with the text so long titles wrap like the heading does.
	useEffect(() => {
		const el = inputRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [editing, title]);

	const save = () => {
		const next = title.trim();
		if (next && next !== task.title) onSave({ title: next });
		else setTitle(task.title);
		setEditing(false);
	};

	if (editing) {
		return (
			<textarea
				ref={inputRef}
				rows={1}
				value={title}
				aria-label="Task title"
				onChange={(e) => setTitle(e.target.value.replace(/\n/g, " "))}
				onBlur={save}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						save();
					}
					if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						setTitle(task.title);
						setEditing(false);
					}
				}}
				disabled={saving}
				className="-mx-1.5 block w-[calc(100%+0.75rem)] resize-none overflow-hidden rounded-lg bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] px-1.5 font-[inherit] text-inherit leading-[inherit] tracking-[inherit] outline-none focus-visible:outline-2 focus-visible:outline-ring"
			/>
		);
	}

	return (
		<span
			role="button"
			tabIndex={0}
			title="Click to rename"
			onClick={() => setEditing(true)}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === "F2") {
					e.preventDefault();
					setEditing(true);
				}
			}}
			className={cn("-mx-1.5 cursor-text rounded-lg px-1.5 transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out) hover:bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)]", focusRing)}
		>
			{task.title}
		</span>
	);
}
