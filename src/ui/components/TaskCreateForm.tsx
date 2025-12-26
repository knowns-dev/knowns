import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { X, AlignLeft, ClipboardCheck, User, Plus, Trash2, ArrowUp } from "lucide-react";
import type { Task, TaskPriority, TaskStatus } from "../../models/task";
import { useTheme } from "../App";
import { createTask } from "../api/client";
import MarkdownEditor from "./MarkdownEditor";

interface TaskCreateFormProps {
	isOpen: boolean;
	allTasks: Task[];
	onClose: () => void;
	onCreated: () => void;
}

const statusOptions: { value: TaskStatus; label: string; lightColor: string; darkColor: string }[] =
	[
		{
			value: "todo",
			label: "To Do",
			lightColor: "bg-gray-100 text-gray-700",
			darkColor: "bg-gray-700 text-gray-300",
		},
		{
			value: "in-progress",
			label: "In Progress",
			lightColor: "bg-blue-100 text-blue-700",
			darkColor: "bg-blue-900/50 text-blue-300",
		},
		{
			value: "in-review",
			label: "In Review",
			lightColor: "bg-purple-100 text-purple-700",
			darkColor: "bg-purple-900/50 text-purple-300",
		},
		{
			value: "done",
			label: "Done",
			lightColor: "bg-green-100 text-green-700",
			darkColor: "bg-green-900/50 text-green-300",
		},
		{
			value: "blocked",
			label: "Blocked",
			lightColor: "bg-red-100 text-red-700",
			darkColor: "bg-red-900/50 text-red-300",
		},
	];

const priorityOptions: {
	value: TaskPriority;
	label: string;
	lightColor: string;
	darkColor: string;
}[] = [
	{
		value: "low",
		label: "Low",
		lightColor: "bg-gray-100 text-gray-600",
		darkColor: "bg-gray-700 text-gray-300",
	},
	{
		value: "medium",
		label: "Medium",
		lightColor: "bg-yellow-100 text-yellow-700",
		darkColor: "bg-yellow-900/50 text-yellow-300",
	},
	{
		value: "high",
		label: "High",
		lightColor: "bg-red-100 text-red-700",
		darkColor: "bg-red-900/50 text-red-300",
	},
];


export default function TaskCreateForm({
	isOpen,
	allTasks,
	onClose,
	onCreated,
}: TaskCreateFormProps) {
	const { isDark } = useTheme();
	const dialogRef = useRef<HTMLDialogElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const titleInputRef = useRef<HTMLInputElement>(null);

	// Form states
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [status, setStatus] = useState<TaskStatus>("todo");
	const [priority, setPriority] = useState<TaskPriority>("medium");
	const [assignee, setAssignee] = useState("");
	const [labels, setLabels] = useState<string[]>([]);
	const [parentId, setParentId] = useState<string>("");
	const [acceptanceCriteria, setAcceptanceCriteria] = useState<{ id: string; text: string }[]>([]);

	// UI states
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);
	const [newACText, setNewACText] = useState("");
	const [addingAC, setAddingAC] = useState(false);
	const [newLabel, setNewLabel] = useState("");
	const [addingLabel, setAddingLabel] = useState(false);
	const [selectingParent, setSelectingParent] = useState(false);

	const newACInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (isOpen) {
			dialogRef.current?.showModal();
			setTimeout(() => titleInputRef.current?.focus(), 100);
		} else {
			dialogRef.current?.close();
			// Reset form
			setTitle("");
			setDescription("");
			setStatus("todo");
			setPriority("medium");
			setAssignee("");
			setLabels([]);
			setParentId("");
			setAcceptanceCriteria([]);
			setError(null);
			setSuccess(false);
			setNewACText("");
			setAddingAC(false);
			setNewLabel("");
			setAddingLabel(false);
			setSelectingParent(false);
		}
	}, [isOpen]);

	useEffect(() => {
		if (addingAC && newACInputRef.current) newACInputRef.current.focus();
	}, [addingAC]);

	const handleBackdropClick = (e: React.MouseEvent) => {
		if (contentRef.current && !contentRef.current.contains(e.target as Node)) {
			onClose();
		}
	};

	const handleDialogKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Escape" && !addingAC && !addingLabel) {
				onClose();
			}
		},
		[onClose, addingAC, addingLabel]
	);

	// AC handlers
	const handleACAdd = () => {
		if (!newACText.trim()) return;
		setAcceptanceCriteria([
			...acceptanceCriteria,
			{ id: crypto.randomUUID(), text: newACText.trim() },
		]);
		setNewACText("");
		setAddingAC(false);
	};

	const handleACDelete = (id: string) => {
		setAcceptanceCriteria(acceptanceCriteria.filter((ac) => ac.id !== id));
	};

	// Label handlers
	const handleLabelAdd = () => {
		if (!newLabel.trim()) return;
		if (!labels.includes(newLabel.trim())) {
			setLabels([...labels, newLabel.trim()]);
		}
		setNewLabel("");
		setAddingLabel(false);
	};

	const handleLabelRemove = (label: string) => {
		setLabels(labels.filter((l) => l !== label));
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);

		if (!title.trim()) {
			setError("Title is required");
			return;
		}

		setSaving(true);

		try {
			const taskData = {
				title: title.trim(),
				description: description.trim() || undefined,
				status,
				priority,
				labels,
				assignee: assignee.trim() || undefined,
				parent: parentId || undefined,
				acceptanceCriteria: acceptanceCriteria.map((ac) => ({
					text: ac.text,
					completed: false,
				})),
			};

			await createTask(taskData);
			setSuccess(true);

			setTimeout(() => {
				onCreated();
				onClose();
			}, 800);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to create task");
		} finally {
			setSaving(false);
		}
	};

	const currentStatus = statusOptions.find((s) => s.value === status);
	const currentPriority = priorityOptions.find((p) => p.value === priority);
	const parentTask = parentId ? allTasks.find((t) => t.id === parentId) : null;

	// Theme classes
	const bgMain = isDark ? "bg-gray-800" : "bg-gray-100";
	const bgCard = isDark ? "bg-gray-700" : "bg-white";
	const bgSidebar = isDark ? "bg-gray-750" : "bg-gray-50";
	const textPrimary = isDark ? "text-gray-100" : "text-gray-900";
	const textSecondary = isDark ? "text-gray-300" : "text-gray-700";
	const textMuted = isDark ? "text-gray-400" : "text-gray-500";
	const borderColor = isDark ? "border-gray-600" : "border-gray-200";
	const inputBg = isDark
		? "bg-gray-600 border-gray-500 text-gray-100 placeholder-gray-400"
		: "bg-white border-gray-200 text-gray-900 placeholder-gray-400";
	const hoverBg = isDark ? "hover:bg-gray-600" : "hover:bg-gray-100";

	return (
		<dialog
			ref={dialogRef}
			className="fixed inset-0 bg-transparent p-0 m-0 max-w-none w-full h-full backdrop:bg-black backdrop:bg-opacity-60"
			onClick={handleBackdropClick}
			onKeyDown={handleDialogKeyDown}
			aria-labelledby="create-task-title"
		>
			<div className="flex justify-center pt-12 pb-8 px-4 min-h-full">
				<div
					ref={contentRef}
					className={`${bgMain} rounded-xl shadow-2xl w-full max-w-4xl max-h-[calc(100vh-80px)] overflow-hidden flex flex-col`}
				>
					{/* Header */}
					<div className="bg-gradient-to-r from-green-500 to-green-600 px-6 py-4 flex items-start justify-between">
						<div className="flex-1 min-w-0">
							<span className="text-green-100 text-sm font-medium">New Task</span>
							<input
								ref={titleInputRef}
								type="text"
								value={title}
								onChange={(e) => setTitle(e.target.value)}
								placeholder="Enter task title..."
								className="w-full text-xl font-bold bg-white/20 text-white placeholder-white/60 border-0 rounded px-2 py-1 mt-1 focus:outline-none focus:ring-2 focus:ring-white/50"
								disabled={saving}
							/>
						</div>
						<button
							type="button"
							onClick={onClose}
							className="text-white/80 hover:text-white hover:bg-white/20 rounded-full p-2 ml-4 transition-colors"
							aria-label="Close"
						>
							<X className="w-5 h-5" />
						</button>
					</div>

					{/* Notifications */}
					{(success || error) && (
						<div className="px-6 pt-4">
							{success && (
								<div
									className={`${isDark ? "bg-green-900/50 border-green-700 text-green-300" : "bg-green-50 border-green-200 text-green-700"} border px-4 py-2 rounded-lg text-sm`}
								>
									Task created successfully!
								</div>
							)}
							{error && (
								<div
									className={`${isDark ? "bg-red-900/50 border-red-700 text-red-300" : "bg-red-50 border-red-200 text-red-700"} border px-4 py-2 rounded-lg text-sm`}
								>
									{error}
								</div>
							)}
						</div>
					)}

					{/* Content */}
					<form onSubmit={handleSubmit} className="flex-1 overflow-y-auto">
						<div className="flex flex-col md:flex-row">
							{/* Main Content */}
							<div className="flex-1 p-6 space-y-6">
								{/* Description */}
								<section>
									<div className="flex items-center gap-2 mb-3">
										<span className={textSecondary}>
											<AlignLeft className="w-5 h-5" />
										</span>
										<h3 className={`font-semibold ${textSecondary}`}>Description</h3>
									</div>
									<MarkdownEditor
										markdown={description}
										onChange={setDescription}
										placeholder="Add a more detailed description..."
										readOnly={saving}
									/>
								</section>

								{/* Acceptance Criteria */}
								<section>
									<div className="flex items-center justify-between mb-3">
										<div className="flex items-center gap-2">
											<span className={textSecondary}>
												<ClipboardCheck className="w-5 h-5" />
											</span>
											<h3 className={`font-semibold ${textSecondary}`}>Acceptance Criteria</h3>
											{acceptanceCriteria.length > 0 && (
												<span className={`text-sm ${textMuted}`}>
													({acceptanceCriteria.length})
												</span>
											)}
										</div>
									</div>

									{/* AC List */}
									<div className="space-y-2">
										{acceptanceCriteria.map((ac) => (
											<div
												key={ac.id}
												className={`flex items-start gap-2 ${bgCard} rounded-lg px-3 py-2 group hover:shadow-sm transition-shadow`}
											>
												<input
													type="checkbox"
													checked={false}
													disabled
													className="mt-1 w-4 h-4 rounded cursor-not-allowed opacity-50"
												/>
												<span className={`flex-1 text-sm ${textSecondary}`}>{ac.text}</span>
												<button
													type="button"
													onClick={() => handleACDelete(ac.id)}
													className={`opacity-0 group-hover:opacity-100 ${textMuted} hover:text-red-500 p-1 transition-all`}
													title="Delete"
												>
													<Trash2 className="w-4 h-4" />
												</button>
											</div>
										))}
									</div>

									{/* Add AC */}
									{addingAC ? (
										<div className={`mt-2 ${bgCard} rounded-lg px-3 py-2`}>
											<input
												ref={newACInputRef}
												type="text"
												value={newACText}
												onChange={(e) => setNewACText(e.target.value)}
												onKeyDown={(e) => {
													if (e.key === "Enter" && newACText.trim()) {
														e.preventDefault();
														handleACAdd();
													}
													if (e.key === "Escape") {
														setNewACText("");
														setAddingAC(false);
													}
												}}
												placeholder="Add an item..."
												className={`w-full border ${borderColor} rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 ${inputBg}`}
												disabled={saving}
											/>
											<div className="flex gap-2 mt-2">
												<button
													type="button"
													onClick={handleACAdd}
													className="px-3 py-1 bg-green-600 text-white text-sm rounded hover:bg-green-700 transition-colors"
													disabled={!newACText.trim() || saving}
												>
													Add
												</button>
												<button
													type="button"
													onClick={() => {
														setNewACText("");
														setAddingAC(false);
													}}
													className={`px-3 py-1 ${textSecondary} text-sm ${hoverBg} rounded transition-colors`}
												>
													Cancel
												</button>
											</div>
										</div>
									) : (
										<button
											type="button"
											onClick={() => setAddingAC(true)}
											className={`mt-2 flex items-center gap-1 text-sm ${textMuted} hover:${textSecondary} ${hoverBg} px-3 py-2 rounded-lg transition-colors w-full`}
											disabled={saving}
										>
											<Plus className="w-4 h-4" />
											<span>Add an item</span>
										</button>
									)}
								</section>
							</div>

							{/* Sidebar */}
							<div
								className={`w-full md:w-64 ${bgSidebar} p-4 border-t md:border-t-0 md:border-l ${borderColor} space-y-4`}
							>
								{/* Status */}
								<div>
									<label
										className={`block text-xs font-semibold ${textMuted} uppercase tracking-wide mb-2`}
									>
										Status
									</label>
									<select
										value={status}
										onChange={(e) => setStatus(e.target.value as TaskStatus)}
										className={`w-full rounded-lg px-3 py-2 text-sm font-medium border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-green-500 ${isDark ? currentStatus?.darkColor : currentStatus?.lightColor}`}
										disabled={saving}
									>
										{statusOptions.map((opt) => (
											<option key={opt.value} value={opt.value}>
												{opt.label}
											</option>
										))}
									</select>
								</div>

								{/* Priority */}
								<div>
									<label
										className={`block text-xs font-semibold ${textMuted} uppercase tracking-wide mb-2`}
									>
										Priority
									</label>
									<select
										value={priority}
										onChange={(e) => setPriority(e.target.value as TaskPriority)}
										className={`w-full rounded-lg px-3 py-2 text-sm font-medium border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-green-500 ${isDark ? currentPriority?.darkColor : currentPriority?.lightColor}`}
										disabled={saving}
									>
										{priorityOptions.map((opt) => (
											<option key={opt.value} value={opt.value}>
												{opt.label}
											</option>
										))}
									</select>
								</div>

								{/* Assignee */}
								<div>
									<label
										className={`block text-xs font-semibold ${textMuted} uppercase tracking-wide mb-2`}
									>
										Assignee
									</label>
									<div
										className={`flex items-center gap-2 ${bgCard} rounded-lg px-3 py-2 border ${borderColor}`}
									>
										<span className={textMuted}>
											<User className="w-5 h-5" />
										</span>
										<input
											type="text"
											value={assignee}
											onChange={(e) => setAssignee(e.target.value)}
											placeholder="@username"
											className={`flex-1 text-sm bg-transparent focus:outline-none ${textPrimary}`}
											disabled={saving}
										/>
									</div>
								</div>

								{/* Labels */}
								<div>
									<label
										className={`block text-xs font-semibold ${textMuted} uppercase tracking-wide mb-2`}
									>
										Labels
									</label>
									<div className="flex flex-wrap gap-1 mb-2">
										{labels.map((label) => (
											<span
												key={label}
												className={`inline-flex items-center gap-1 text-xs ${isDark ? "bg-blue-900/50 text-blue-300" : "bg-blue-100 text-blue-700"} px-2 py-1 rounded-full group`}
											>
												{label}
												<button
													type="button"
													onClick={() => handleLabelRemove(label)}
													className="opacity-0 group-hover:opacity-100 hover:text-red-500 transition-opacity"
													title="Remove label"
												>
													x
												</button>
											</span>
										))}
									</div>
									{addingLabel ? (
										<div>
											<input
												type="text"
												value={newLabel}
												onChange={(e) => setNewLabel(e.target.value)}
												onKeyDown={(e) => {
													if (e.key === "Enter" && newLabel.trim()) {
														e.preventDefault();
														handleLabelAdd();
													}
													if (e.key === "Escape") {
														setNewLabel("");
														setAddingLabel(false);
													}
												}}
												placeholder="Label name"
												className={`w-full border ${borderColor} rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 ${inputBg}`}
												disabled={saving}
											/>
											<div className="flex gap-2 mt-2">
												<button
													type="button"
													onClick={handleLabelAdd}
													className="px-3 py-1 bg-green-600 text-white text-sm rounded hover:bg-green-700 transition-colors"
													disabled={!newLabel.trim() || saving}
												>
													Add
												</button>
												<button
													type="button"
													onClick={() => {
														setNewLabel("");
														setAddingLabel(false);
													}}
													className={`px-3 py-1 ${textSecondary} text-sm ${hoverBg} rounded transition-colors`}
												>
													Cancel
												</button>
											</div>
										</div>
									) : (
										<button
											type="button"
											onClick={() => setAddingLabel(true)}
											className={`flex items-center gap-1 text-sm ${textMuted} hover:${textSecondary} ${hoverBg} px-2 py-1.5 rounded transition-colors`}
											disabled={saving}
										>
											<Plus className="w-4 h-4" />
											<span>Add label</span>
										</button>
									)}
								</div>

								{/* Parent Task */}
								<div>
									<label
										className={`block text-xs font-semibold ${textMuted} uppercase tracking-wide mb-2`}
									>
										Parent Task
									</label>
									{selectingParent ? (
										<div>
											<select
												value={parentId}
												onChange={(e) => {
													setParentId(e.target.value);
													setSelectingParent(false);
												}}
												className={`w-full border ${borderColor} rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 ${inputBg}`}
												disabled={saving}
											>
												<option value="">None</option>
												{allTasks.map((t) => (
													<option key={t.id} value={t.id}>
														#{t.id} - {t.title}
													</option>
												))}
											</select>
											<button
												type="button"
												onClick={() => setSelectingParent(false)}
												className={`mt-2 px-3 py-1 ${textSecondary} text-sm ${hoverBg} rounded transition-colors`}
											>
												Cancel
											</button>
										</div>
									) : parentTask ? (
										<button
											type="button"
											onClick={() => setSelectingParent(true)}
											className={`w-full flex items-center gap-2 ${bgCard} rounded-lg px-3 py-2 text-sm text-left ${hoverBg} transition-colors border ${borderColor}`}
											disabled={saving}
										>
											<span className={textMuted}>
												<ArrowUp className="w-4 h-4" />
											</span>
											<div className="flex-1 min-w-0">
												<span className={`text-xs ${textMuted} font-mono`}>#{parentTask.id}</span>
												<p className={`${textSecondary} truncate`}>{parentTask.title}</p>
											</div>
										</button>
									) : (
										<button
											type="button"
											onClick={() => setSelectingParent(true)}
											className={`flex items-center gap-1 text-sm ${textMuted} hover:${textSecondary} ${hoverBg} px-2 py-1.5 rounded transition-colors`}
											disabled={saving}
										>
											<Plus className="w-4 h-4" />
											<span>Set parent</span>
										</button>
									)}
								</div>
							</div>
						</div>
					</form>

					{/* Footer */}
					<div className={`border-t ${borderColor} px-6 py-4 ${bgSidebar} flex justify-end gap-3`}>
						<button
							type="button"
							onClick={onClose}
							className={`px-4 py-2 text-sm ${textSecondary} ${hoverBg} rounded-lg transition-colors`}
							disabled={saving}
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={handleSubmit}
							className="px-6 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors font-medium"
							disabled={saving || success || !title.trim()}
						>
							{saving ? "Creating..." : "Create Task"}
						</button>
					</div>
				</div>
			</div>
		</dialog>
	);
}
