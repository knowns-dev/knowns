import { useEffect, useId, useState, type ReactNode } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/ui/components/ui/knowns/button";
import { cn, focusRing } from "@/ui/lib/knowns/utils";
import { MDEditor, MDRender } from "../../editor";

/** A titled block of the task body: heading on the left, quiet actions on the right. */
export function DetailSection({
	title,
	count,
	actions,
	children,
	className,
}: {
	title: string;
	count?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	const id = useId();
	return (
		<section aria-labelledby={id} className={cn("group/section flex flex-col gap-2", className)}>
			<div className="flex min-h-7 items-center justify-between gap-3">
				<h3 id={id} className="flex items-baseline gap-2 text-[13.5px] font-semibold text-foreground">
					{title}
					{count !== undefined && <span className="text-[12.5px] font-normal text-muted-foreground tabular-nums">{count}</span>}
				</h3>
				{actions && <div className="flex items-center gap-1">{actions}</div>}
			</div>
			{children}
		</section>
	);
}

/**
 * Markdown read view that turns into the editor on click (or Edit), with Save / Cancel.
 * Links inside the rendered markdown keep working: clicks on them don't open the editor.
 */
export function MarkdownField({
	title,
	value,
	placeholder,
	emptyText,
	saving,
	onSave,
}: {
	title: string;
	value: string;
	placeholder: string;
	emptyText: string;
	saving: boolean;
	onSave: (next: string) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(value);

	useEffect(() => {
		if (!editing) setDraft(value);
	}, [value, editing]);

	const save = () => {
		if (draft !== value) onSave(draft);
		setEditing(false);
	};
	const cancel = () => {
		setDraft(value);
		setEditing(false);
	};

	return (
		<DetailSection
			title={title}
			actions={
				!editing && value ? (
					<Button
						size="xs"
						variant="ghost"
						icon={<Pencil />}
						aria-label={`Edit ${title}`}
						className="text-muted-foreground opacity-100 transition-opacity sm:opacity-0 sm:group-hover/section:opacity-100 sm:focus-visible:opacity-100"
						onClick={() => setEditing(true)}
					/>
				) : undefined
			}
		>
			{editing ? (
				<div
					className="flex flex-col gap-2"
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							e.stopPropagation();
							cancel();
						}
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							save();
						}
					}}
				>
					<MDEditor markdown={draft} onChange={setDraft} placeholder={placeholder} readOnly={saving} height={220} />
					<div className="flex items-center gap-2">
						<Button size="sm" onClick={save} disabled={saving}>
							Save
						</Button>
						<Button size="sm" variant="ghost" onClick={cancel}>
							Cancel
						</Button>
						<span className="ml-auto hidden text-[12px] text-muted-foreground sm:inline">Ctrl+Enter to save, Esc to cancel</span>
					</div>
				</div>
			) : value ? (
				<div
					role="button"
					tabIndex={0}
					aria-label={`${title}. Click to edit`}
					onClick={(e) => {
						// Links, mention badges and copy buttons inside the markdown do their own thing.
						const hit = (e.target as HTMLElement).closest("a, button, [role='link'], input, summary");
						if (hit && hit !== e.currentTarget) return;
						if (window.getSelection()?.toString()) return;
						setEditing(true);
					}}
					onKeyDown={(e) => {
						if (e.target === e.currentTarget && e.key === "Enter") setEditing(true);
					}}
					className={cn(
						"-mx-2 cursor-text rounded-lg px-2 py-1 transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--foreground)_3%,transparent)]",
						focusRing,
					)}
				>
					<MDRender markdown={value} className="prose prose-sm max-w-[72ch] text-[14px] leading-relaxed dark:prose-invert [&>:first-child]:mt-0! [&>:last-child]:mb-0!" />
				</div>
			) : (
				<button
					type="button"
					onClick={() => setEditing(true)}
					className={cn(
						"-mx-2 rounded-lg border border-dashed border-[color-mix(in_srgb,var(--foreground)_14%,transparent)] px-3 py-3 text-left text-[13.5px] text-muted-foreground transition-colors duration-150 hover:border-[color-mix(in_srgb,var(--foreground)_24%,transparent)] hover:text-foreground",
						focusRing,
					)}
				>
					{emptyText}
				</button>
			)}
		</DetailSection>
	);
}
