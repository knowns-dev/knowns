import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Task, TaskPriority, TaskStatus } from "@models/task";
import { useCurrentUser } from "../../contexts/UserContext";
import { useConfig } from "../../contexts/ConfigContext";
import { createTask } from "../../api/client";
import { toast } from "../ui/sonner";
import AssigneeDropdown from "./AssigneeDropdown";
import { Dialog } from "@/ui/components/ui/knowns/dialog";
import { Button } from "@/ui/components/ui/knowns/button";
import { Combobox } from "@/ui/components/ui/knowns/combobox";
import { Field, Input } from "@/ui/components/ui/knowns/input";
import { Select } from "@/ui/components/ui/knowns/select";
import { Tag } from "@/ui/components/ui/knowns/tag";
import { Textarea } from "@/ui/components/ui/knowns/textarea";
import { buildStatusOptions } from "../../utils/colors";

interface TaskCreateFormProps {
	isOpen: boolean;
	allTasks: Task[];
	onClose: () => void;
	onCreated: () => void;
}

const PRIORITY_OPTIONS: { value: TaskPriority; label: string }[] = [
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
];

const TITLE_MAX = 200;
const PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,7}$/;

interface CriterionRow {
	id: string;
	text: string;
}

type FieldName = "title" | "prefix" | "criteria" | "labels";
type Errors = Partial<Record<FieldName, string>>;

const newRow = (text = ""): CriterionRow => ({ id: crypto.randomUUID(), text });

export default function TaskCreateForm({ isOpen, allTasks, onClose, onCreated }: TaskCreateFormProps) {
	const { currentUser } = useCurrentUser();
	const { config } = useConfig();
	const uid = useId();
	const formId = `${uid}-form`;
	const ids = {
		title: `${uid}-title`,
		description: `${uid}-description`,
		status: `${uid}-status`,
		priority: `${uid}-priority`,
		labels: `${uid}-labels`,
		parent: `${uid}-parent`,
		prefix: `${uid}-prefix`,
	};

	const statusOptions = useMemo(
		() => buildStatusOptions(config.statuses || ["todo", "in-progress", "in-review", "done", "blocked"]),
		[config.statuses],
	);

	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [status, setStatus] = useState<TaskStatus>("todo");
	const [priority, setPriority] = useState<TaskPriority>("medium");
	const [assignee, setAssignee] = useState("");
	const [labels, setLabels] = useState<string[]>([]);
	const [labelDraft, setLabelDraft] = useState("");
	const [parentId, setParentId] = useState("");
	const [prefix, setPrefix] = useState("");
	const [criteria, setCriteria] = useState<CriterionRow[]>([]);
	const [showAdvanced, setShowAdvanced] = useState(false);

	const [errors, setErrors] = useState<Errors>({});
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const criterionRefs = useRef(new Map<string, HTMLInputElement>());
	const pendingFocus = useRef<string | null>(null);

	// Keep the dialog in the DOM only while open (plus its exit fade), so its labels never leak into page queries.
	const [mounted, setMounted] = useState(isOpen);
	useEffect(() => {
		if (isOpen) {
			setMounted(true);
			return;
		}
		const timer = window.setTimeout(() => setMounted(false), 250);
		return () => window.clearTimeout(timer);
	}, [isOpen]);

	// Start clean every time the form closes.
	useEffect(() => {
		if (isOpen) return;
		setTitle("");
		setDescription("");
		setStatus("todo");
		setPriority("medium");
		setAssignee("");
		setLabels([]);
		setLabelDraft("");
		setParentId("");
		setPrefix("");
		setCriteria([]);
		setShowAdvanced(false);
		setErrors({});
		setSubmitError(null);
		setSaving(false);
	}, [isOpen]);

	// Focus a freshly added acceptance criterion row.
	useEffect(() => {
		if (!pendingFocus.current) return;
		criterionRefs.current.get(pendingFocus.current)?.focus();
		pendingFocus.current = null;
	}, [criteria]);

	const parentOptions = useMemo(
		() => [
			{ value: "", label: "None" },
			...allTasks.map((t) => ({ value: t.id, label: t.title, supportingText: `#${t.id}` })),
		],
		[allTasks],
	);

	const knownLabels = useMemo(() => {
		const all = new Set<string>();
		for (const t of allTasks) for (const l of t.labels ?? []) all.add(l);
		return [...all].filter((l) => !labels.includes(l)).sort();
	}, [allTasks, labels]);

	const clearError = (name: FieldName) => setErrors((prev) => (prev[name] ? { ...prev, [name]: undefined } : prev));

	// Labels
	const addLabel = (raw: string) => {
		const label = raw.trim().replace(/,$/, "").trim();
		if (!label) return;
		setLabels((prev) => (prev.includes(label) ? prev : [...prev, label]));
		setLabelDraft("");
		clearError("labels");
	};
	const onLabelKey = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter" || e.key === ",") {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) return; // submit shortcut
			e.preventDefault();
			addLabel(labelDraft);
		} else if (e.key === "Backspace" && !labelDraft) {
			setLabels((prev) => prev.slice(0, -1));
		}
	};

	// Acceptance criteria
	const addCriterion = () => {
		const row = newRow();
		pendingFocus.current = row.id;
		setCriteria((prev) => [...prev, row]);
	};
	const removeCriterion = (id: string, focusPrev = false) => {
		setCriteria((prev) => {
			const index = prev.findIndex((r) => r.id === id);
			if (focusPrev) {
				const target = prev[index - 1] ?? prev[index + 1];
				if (target) pendingFocus.current = target.id;
			}
			return prev.filter((r) => r.id !== id);
		});
		clearError("criteria");
	};
	const onCriterionKey = (e: KeyboardEvent<HTMLInputElement>, row: CriterionRow) => {
		if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			if (row.text.trim()) addCriterion();
		} else if (e.key === "Backspace" && !row.text) {
			e.preventDefault();
			removeCriterion(row.id, true);
		}
	};

	const validate = (): Errors => {
		const next: Errors = {};
		const trimmed = title.trim();
		if (!trimmed) next.title = "Title is required.";
		else if (trimmed.length > TITLE_MAX) next.title = `Title must be ${TITLE_MAX} characters or fewer.`;

		const normalizedPrefix = prefix.trim().toUpperCase();
		if (normalizedPrefix && !PREFIX_PATTERN.test(normalizedPrefix))
			next.prefix = "Use 2 to 8 letters or numbers, starting with a letter.";

		const seen = new Set<string>();
		for (const row of criteria) {
			const text = row.text.trim().toLowerCase();
			if (!text) continue;
			if (seen.has(text)) {
				next.criteria = "Two acceptance criteria are identical.";
				break;
			}
			seen.add(text);
		}
		return next;
	};

	const focusFirstInvalid = (found: Errors) => {
		const order: [FieldName, () => HTMLElement | null | undefined][] = [
			["title", () => document.getElementById(ids.title)],
			["prefix", () => document.getElementById(ids.prefix)],
			["criteria", () => criterionRefs.current.get(criteria[0]?.id ?? "")],
		];
		for (const [name, get] of order) {
			if (!found[name]) continue;
			if (name === "prefix") setShowAdvanced(true);
			// The advanced section mounts on the next paint.
			requestAnimationFrame(() => get()?.focus());
			return;
		}
	};

	const submit = async () => {
		if (saving) return;
		setSubmitError(null);
		const found = validate();
		setErrors(found);
		if (Object.values(found).some(Boolean)) {
			focusFirstInvalid(found);
			return;
		}

		setSaving(true);
		try {
			const normalizedPrefix = prefix.trim().toUpperCase();
			await createTask({
				title: title.trim(),
				description: description.trim() || undefined,
				status,
				priority,
				labels,
				assignee: assignee.trim() || undefined,
				parent: parentId || undefined,
				prefix: normalizedPrefix || undefined,
				acceptanceCriteria: criteria
					.map((row) => row.text.trim())
					.filter(Boolean)
					.map((text) => ({ text, completed: false })),
			});
			toast.success("Task created", { description: title.trim() });
			onCreated();
			onClose();
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to create task";
			setSubmitError(message);
			toast.error("Failed to create task", { description: message });
			setSaving(false);
		}
	};

	const onFormKey = (e: KeyboardEvent<HTMLFormElement>) => {
		if (e.key !== "Enter") return;
		if (e.metaKey || e.ctrlKey) {
			e.preventDefault();
			void submit();
			return;
		}
		// Plain Enter in a single-line field never submits by accident.
		const el = e.target as HTMLElement;
		if (el instanceof HTMLInputElement && !e.defaultPrevented) {
			e.preventDefault();
			if (el.id === ids.title) document.getElementById(ids.description)?.focus();
		}
	};

	if (!isOpen && !mounted) return null;

	return (
		<Dialog
			open={isOpen}
			onOpenChange={(open) => !open && !saving && onClose()}
			title="New task"
			description="Capture the work. You can fill in the rest from the task detail later."
			size="lg"
			sheet
			className="open:flex max-h-[calc(100dvh-2rem)] flex-col"
			bodyClassName="min-h-0 flex-1 overflow-y-auto px-5 py-3"
			footer={
				<>
					<span className="mr-auto hidden items-center text-xs text-muted-foreground sm:flex">
						Press Ctrl or Cmd + Enter to create
					</span>
					<Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
						Cancel
					</Button>
					<Button type="submit" form={formId} loading={saving}>
						{saving ? "Creating..." : "Create Task"}
					</Button>
				</>
			}
		>
			<form id={formId} noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }} onKeyDown={onFormKey} className="flex flex-col gap-4">
				{submitError && (
					<p role="alert" className="rounded-[9px] bg-red-500/[0.06] px-3 py-2 text-sm text-red-700 shadow-[0_0_0_1px_rgb(239_68_68/0.22)] dark:text-red-300">
						{submitError}
					</p>
				)}

				<Field label="Title" id={ids.title} required error={errors.title}>
					<Input
						id={ids.title}
						data-autofocus
						value={title}
						onChange={(e) => {
							setTitle(e.target.value);
							clearError("title");
						}}
						placeholder="Enter task title..."
						autoComplete="off"
						disabled={saving}
					/>
				</Field>

				<Field label="Description" id={ids.description} optional>
					<Textarea
						id={ids.description}
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						placeholder="What needs to happen, and why. Markdown works."
						autosize
						minRows={3}
						maxRows={8}
						disabled={saving}
					/>
				</Field>

				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Field label="Status" id={ids.status}>
						<Select id={ids.status} options={statusOptions} value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)} disabled={saving} />
					</Field>
					<Field label="Priority" id={ids.priority}>
						<Select id={ids.priority} options={PRIORITY_OPTIONS} value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)} disabled={saving} />
					</Field>
					<div className="flex flex-col gap-1.5">
						<span className="text-[13px] font-medium">Assignee</span>
						<AssigneeDropdown value={assignee} onChange={setAssignee} showGrabButton={false} currentUser={currentUser} />
					</div>
					<Field label="Parent task" id={ids.parent} optional>
						<Combobox
							id={ids.parent}
							options={parentOptions}
							value={parentId}
							onValueChange={setParentId}
							searchable
							presentation="auto"
							aria-label="Parent task"
							emptyText="No task found."
							disabled={saving}
						/>
					</Field>
				</div>

				<Field label="Labels" id={ids.labels} optional hint="Press Enter or comma to add a label." error={errors.labels}>
					<div className="flex flex-col gap-2">
						<Input
							id={ids.labels}
							value={labelDraft}
							onChange={(e) => setLabelDraft(e.target.value)}
							onKeyDown={onLabelKey}
							onBlur={() => addLabel(labelDraft)}
							placeholder="Add a label..."
							list={`${uid}-label-options`}
							autoComplete="off"
							disabled={saving}
						/>
						<datalist id={`${uid}-label-options`}>
							{knownLabels.map((l) => (
								<option key={l} value={l} />
							))}
						</datalist>
						{labels.length > 0 && (
							<ul className="flex flex-wrap gap-1.5" aria-label="Selected labels">
								{labels.map((label) => (
									<li key={label}>
										<Tag size="sm" onRemove={() => setLabels((prev) => prev.filter((l) => l !== label))} removeLabel={`Remove label ${label}`}>
											{label}
										</Tag>
									</li>
								))}
							</ul>
						)}
					</div>
				</Field>

				<fieldset className="flex flex-col gap-2" disabled={saving}>
					<legend className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium">
						Acceptance criteria
						<span className="text-[12px] font-normal text-muted-foreground">Optional</span>
					</legend>
					{criteria.map((row, i) => (
						<div key={row.id} className="flex items-center gap-2">
							<Input
								ref={(el) => {
									if (el) criterionRefs.current.set(row.id, el);
									else criterionRefs.current.delete(row.id);
								}}
								value={row.text}
								onChange={(e) => {
									const text = e.target.value;
									setCriteria((prev) => prev.map((r) => (r.id === row.id ? { ...r, text } : r)));
									clearError("criteria");
								}}
								onKeyDown={(e) => onCriterionKey(e, row)}
								aria-label={`Acceptance criterion ${i + 1}`}
								aria-invalid={errors.criteria ? true : undefined}
								placeholder="Add an item..."
								autoComplete="off"
							/>
							<Button type="button" variant="ghost" aria-label={`Remove criterion ${i + 1}`} onClick={() => removeCriterion(row.id, true)} icon={<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>} />
						</div>
					))}
					{errors.criteria && (
						<p className="text-xs text-red-600 dark:text-red-400" role="alert">
							{errors.criteria}
						</p>
					)}
					<div>
						<Button type="button" variant="secondary" size="sm" onClick={addCriterion} icon={<svg viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>}>
							Add an item
						</Button>
					</div>
				</fieldset>

				<div className="flex flex-col gap-3">
					<div>
						<Button type="button" variant="quiet" size="sm" aria-expanded={showAdvanced} aria-controls={`${uid}-advanced`} onClick={() => setShowAdvanced((v) => !v)}>
							{showAdvanced ? "Hide advanced" : "Advanced"}
						</Button>
					</div>
					{showAdvanced && (
						<div id={`${uid}-advanced`}>
							<Field label="Task ID prefix" id={ids.prefix} optional hint="Overrides the project default for this task only." error={errors.prefix}>
								<Input
									id={ids.prefix}
									value={prefix}
									onChange={(e) => {
										setPrefix(e.target.value.toUpperCase());
										clearError("prefix");
									}}
									placeholder={config.defaultTaskIdPrefix || "Project default"}
									maxLength={8}
									autoComplete="off"
									disabled={saving}
								/>
							</Field>
						</div>
					)}
				</div>
			</form>
		</Dialog>
	);
}
