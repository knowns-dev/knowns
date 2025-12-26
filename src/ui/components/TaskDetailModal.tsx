import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	X,
	AlignLeft,
	ClipboardCheck,
	Clock,
	FileText,
	Pencil,
	Plus,
	Trash2,
	Archive,
	ArrowUp,
} from "lucide-react";
import type { Task, TaskPriority, TaskStatus } from "../../models/task";
import { useTheme } from "../App";
import { useCurrentUser } from "../contexts/UserContext";
import { updateTask } from "../api/client";
import AssigneeDropdown from "./AssigneeDropdown";
import { TiptapEditor, EditorRender } from "./editor";
import TaskHistoryPanel from "./TaskHistoryPanel";
import TimeTracker from "./TimeTracker";
import { ScrollArea } from "./ui/scroll-area";

interface TaskDetailModalProps {
	task: Task | null;
	allTasks: Task[];
	onClose: () => void;
	onUpdate: (task: Task) => void;
	onDelete?: (taskId: string) => void;
	onNavigateToTask?: (taskId: string) => void;
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


export default function TaskDetailModal({
	task,
	allTasks,
	onClose,
	onUpdate,
	onDelete,
	onNavigateToTask,
}: TaskDetailModalProps) {
	const { isDark } = useTheme();
	const { currentUser } = useCurrentUser();
	const dialogRef = useRef<HTMLDialogElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);

	const [editingTitle, setEditingTitle] = useState(false);
	const [title, setTitle] = useState("");
	const [editingDescription, setEditingDescription] = useState(false);
	const [description, setDescription] = useState("");
	const [editingPlan, setEditingPlan] = useState(false);
	const [plan, setPlan] = useState("");
	const [editingNotes, setEditingNotes] = useState(false);
	const [notes, setNotes] = useState("");
	const [saving, setSaving] = useState(false);
	const [newACText, setNewACText] = useState("");
	const [addingAC, setAddingAC] = useState(false);
	const [editingACIndex, setEditingACIndex] = useState<number | null>(null);
	const [editingACText, setEditingACText] = useState("");
	const [newLabel, setNewLabel] = useState("");
	const [addingLabel, setAddingLabel] = useState(false);
	const [editingAssignee, setEditingAssignee] = useState(false);
	const [assignee, setAssignee] = useState("");

	const titleInputRef = useRef<HTMLInputElement>(null);
	const newACInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (task) {
			setTitle(task.title);
			setDescription(task.description || "");
			setPlan(task.implementationPlan || "");
			setNotes(task.implementationNotes || "");
			setAssignee(task.assignee || "");
			dialogRef.current?.showModal();
		} else {
			dialogRef.current?.close();
			setEditingTitle(false);
			setEditingDescription(false);
			setEditingPlan(false);
			setEditingNotes(false);
			setAddingAC(false);
			setEditingACIndex(null);
			setAddingLabel(false);
			setEditingAssignee(false);
		}
	}, [task]);

	// Handle markdown link clicks for internal navigation
	useEffect(() => {
		const handleLinkClick = (e: MouseEvent) => {
			let target = e.target as HTMLElement;

			// If clicked on SVG or child element, find parent anchor
			while (target && target.tagName !== "A" && target !== contentRef.current) {
				target = target.parentElement as HTMLElement;
			}

			if (target && target.tagName === "A") {
				const anchor = target as HTMLAnchorElement;
				const href = anchor.getAttribute("href");

				// Handle hash-based links (already formatted by MarkdownRenderer)
				if (href && href.startsWith("#/")) {
					// Let browser handle hash navigation, just close modal
					onClose();
					return;
				}

				// Handle task links (legacy format: task-123 or task-123.md)
				if (href && /^(task-)?\d+(\.md)?$/.test(href)) {
					e.preventDefault();
					const taskId = href.replace(/^task-/, "").replace(/\.md$/, "");
					window.location.hash = `/kanban/${taskId}`;
					onClose();
					return;
				}

				// Handle document links (legacy format: ./README.md or README.md)
				if (href && (href.endsWith(".md") || href.includes(".md#"))) {
					e.preventDefault();
					// Normalize path
					const normalizedPath = href.replace(/^\.\//, "").replace(/^\//, "");
					// Navigate to docs page with path in URL
					window.location.hash = `/docs/${normalizedPath}`;
					onClose();
				}
			}
		};

		const contentEl = contentRef.current;
		if (contentEl) {
			contentEl.addEventListener("click", handleLinkClick);
			return () => contentEl.removeEventListener("click", handleLinkClick);
		}
	}, [allTasks, onNavigateToTask, onClose]);

	useEffect(() => {
		if (editingTitle && titleInputRef.current) titleInputRef.current.focus();
	}, [editingTitle]);

	useEffect(() => {
		if (addingAC && newACInputRef.current) newACInputRef.current.focus();
	}, [addingAC]);

	// Click outside to close
	const handleBackdropClick = (e: React.MouseEvent) => {
		if (contentRef.current && !contentRef.current.contains(e.target as Node)) {
			onClose();
		}
	};

	const handleDialogKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (
				e.key === "Escape" &&
				!editingTitle &&
				!editingDescription &&
				!editingPlan &&
				!editingNotes &&
				!addingAC &&
				!addingLabel
			) {
				onClose();
			}
		},
		[onClose, editingTitle, editingDescription, editingPlan, editingNotes, addingAC, addingLabel]
	);

	const handleSave = async (updates: Partial<Task>) => {
		if (!task) return;
		setSaving(true);
		try {
			const updated = await updateTask(task.id, updates);
			onUpdate(updated);
		} catch (error) {
			console.error("Failed to update task:", error);
		} finally {
			setSaving(false);
		}
	};

	const handleTitleSave = () => {
		if (title.trim() && title !== task?.title) handleSave({ title: title.trim() });
		setEditingTitle(false);
	};

	const handleDescriptionSave = () => {
		if (description !== task?.description) handleSave({ description: description || undefined });
		setEditingDescription(false);
	};

	const handlePlanSave = () => {
		if (plan !== task?.implementationPlan) handleSave({ implementationPlan: plan || undefined });
		setEditingPlan(false);
	};

	const handleNotesSave = () => {
		if (notes !== task?.implementationNotes)
			handleSave({ implementationNotes: notes || undefined });
		setEditingNotes(false);
	};

	const handleStatusChange = (status: TaskStatus) => handleSave({ status });
	const handlePriorityChange = (priority: TaskPriority) => handleSave({ priority });

	const handleAssigneeSave = () => {
		const trimmed = assignee.trim();
		if (trimmed !== task?.assignee) handleSave({ assignee: trimmed || undefined });
		setEditingAssignee(false);
	};

	const handleACToggle = (index: number) => {
		if (!task) return;
		const newAC = task.acceptanceCriteria.map((ac, i) =>
			i === index ? { ...ac, completed: !ac.completed } : ac
		);
		handleSave({ acceptanceCriteria: newAC });
	};

	const handleACAdd = () => {
		if (!task || !newACText.trim()) return;
		handleSave({
			acceptanceCriteria: [
				...task.acceptanceCriteria,
				{ text: newACText.trim(), completed: false },
			],
		});
		setNewACText("");
		setAddingAC(false);
	};

	const handleACDelete = (index: number) => {
		if (!task) return;
		handleSave({ acceptanceCriteria: task.acceptanceCriteria.filter((_, i) => i !== index) });
	};

	const handleACEditStart = (index: number) => {
		if (!task) return;
		const ac = task.acceptanceCriteria[index];
		if (!ac) return;
		setEditingACIndex(index);
		setEditingACText(ac.text);
	};

	const handleACEditSave = () => {
		if (!task || editingACIndex === null) return;
		const currentAC = task.acceptanceCriteria[editingACIndex];
		if (!currentAC) return;
		if (editingACText.trim() && editingACText !== currentAC.text) {
			handleSave({
				acceptanceCriteria: task.acceptanceCriteria.map((ac, i) =>
					i === editingACIndex ? { ...ac, text: editingACText.trim() } : ac
				),
			});
		}
		setEditingACIndex(null);
		setEditingACText("");
	};

	const handleLabelAdd = () => {
		if (!task || !newLabel.trim()) return;
		if (!task.labels.includes(newLabel.trim())) {
			handleSave({ labels: [...task.labels, newLabel.trim()] });
		}
		setNewLabel("");
		setAddingLabel(false);
	};

	const handleLabelRemove = (label: string) => {
		if (!task) return;
		handleSave({ labels: task.labels.filter((l) => l !== label) });
	};

	if (!task) return null;

	const completedAC = task.acceptanceCriteria.filter((ac) => ac.completed).length;
	const totalAC = task.acceptanceCriteria.length;
	const acProgress = totalAC > 0 ? (completedAC / totalAC) * 100 : 0;
	const currentStatus = statusOptions.find((s) => s.value === task.status);
	const currentPriority = priorityOptions.find((p) => p.value === task.priority);

	// Theme classes
	const bgMain = isDark ? "bg-gray-800" : "bg-gray-100";
	const bgCard = isDark ? "bg-gray-700" : "bg-white";
	const _bgSidebar = isDark ? "bg-gray-750" : "bg-gray-50";
	const _textPrimary = isDark ? "text-gray-100" : "text-gray-900";
	const textSecondary = isDark ? "text-gray-300" : "text-gray-700";
	const textMuted = isDark ? "text-gray-400" : "text-gray-500";
	const borderColor = isDark ? "border-gray-600" : "border-gray-200";
	const inputBg = isDark
		? "bg-gray-600 border-gray-500 text-gray-100"
		: "bg-white border-gray-300 text-gray-900";
	const hoverBg = isDark ? "hover:bg-gray-600" : "hover:bg-gray-50";

	return (
		<dialog
			ref={dialogRef}
			className="fixed inset-0 bg-transparent p-0 m-0 max-w-none w-full h-full backdrop:bg-black backdrop:bg-opacity-60"
			onKeyDown={handleDialogKeyDown}
			aria-labelledby="modal-title"
		>
			<div className="flex justify-center pt-12 pb-8 px-4 min-h-full" onClick={handleBackdropClick}>
				<div
					ref={contentRef}
					className={`${bgMain} rounded-xl shadow-2xl w-full max-w-6xl max-h-[calc(100vh-80px)] overflow-hidden flex flex-col`}
					onClick={(e) => e.stopPropagation()}
				>
					{/* Header */}
					<div className="bg-gradient-to-r from-blue-500 to-blue-600 px-6 py-4 flex items-start justify-between">
						<div className="flex-1 min-w-0">
							<span className="text-blue-100 text-sm font-mono">#{task.id}</span>
							{editingTitle ? (
								<input
									ref={titleInputRef}
									type="text"
									value={title}
									onChange={(e) => setTitle(e.target.value)}
									onBlur={handleTitleSave}
									onKeyDown={(e) => {
										if (e.key === "Enter") handleTitleSave();
										if (e.key === "Escape") {
											setTitle(task.title);
											setEditingTitle(false);
										}
									}}
									className="w-full text-xl font-bold bg-white/20 text-white placeholder-white/60 border-0 rounded px-2 py-1 mt-1 focus:outline-none focus:ring-2 focus:ring-white/50"
								/>
							) : (
								<h2
									id="modal-title"
									className="text-xl font-bold text-white mt-1 cursor-pointer hover:bg-white/10 rounded px-2 py-1 -mx-2 truncate"
									onClick={() => setEditingTitle(true)}
									onKeyDown={(e) => e.key === "Enter" && setEditingTitle(true)}
								>
									{task.title}
								</h2>
							)}
						</div>
						<button
							type="button"
							onClick={onClose}
							className="text-white/80 hover:text-white hover:bg-white/20 rounded-full p-2 ml-4 transition-colors"
							aria-label="Close modal"
						>
							<X className="w-5 h-5" />
						</button>
					</div>

					{/* Content */}
					<div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden">
						{/* Main Content */}
						<ScrollArea className="flex-1 min-h-0">
							<div className="p-6 space-y-6">
								{/* Description */}
								<section>
									<div className={`flex items-center gap-2 mb-3 ${textSecondary}`}>
										<AlignLeft className="w-5 h-5" />
										<h3 className="font-semibold">Description</h3>
									</div>
									{editingDescription ? (
										<div>
											<TiptapEditor
												markdown={description}
												onChange={setDescription}
												placeholder="Add a more detailed description..."
												readOnly={saving}
											/>
											<div className="flex gap-2 mt-2">
												<button
													type="button"
													onClick={handleDescriptionSave}
													className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
													disabled={saving}
												>
													Save
												</button>
												<button
													type="button"
													onClick={() => {
														setDescription(task.description || "");
														setEditingDescription(false);
													}}
													className={`px-4 py-1.5 ${textMuted} text-sm ${hoverBg} rounded`}
												>
													Cancel
												</button>
											</div>
										</div>
									) : (
										<div
											className={`${bgCard} rounded-lg px-3 py-2 min-h-20 cursor-pointer ${hoverBg} transition-colors border ${borderColor} overflow-hidden`}
											onClick={() => setEditingDescription(true)}
											tabIndex={0}
											role="button"
										>
											{task.description ? (
												<EditorRender
													markdown={task.description}
													className={`text-sm ${textSecondary}`}
												/>
											) : (
												<span className={`${textMuted} italic text-sm`}>Add description...</span>
											)}
										</div>
									)}
								</section>

								{/* Acceptance Criteria */}
								<section>
									<div className={`flex items-center gap-2 mb-3 ${textSecondary}`}>
										<ClipboardCheck className="w-5 h-5" />
										<h3 className="font-semibold">Acceptance Criteria</h3>
										{totalAC > 0 && (
											<span className={`text-sm ${textMuted}`}>
												({completedAC}/{totalAC})
											</span>
										)}
									</div>

									{totalAC > 0 && (
										<div className="mb-3 flex items-center gap-2">
											<span className={`text-xs ${textMuted} w-8`}>{Math.round(acProgress)}%</span>
											<div
												className={`flex-1 h-2 ${isDark ? "bg-gray-600" : "bg-gray-200"} rounded-full overflow-hidden`}
											>
												<div
													className={`h-full transition-all ${acProgress === 100 ? "bg-green-500" : "bg-blue-500"}`}
													style={{ width: `${acProgress}%` }}
												/>
											</div>
										</div>
									)}

									<div className="space-y-2">
										{task.acceptanceCriteria.map((ac, index) => (
											<div
												key={`ac-${index}`}
												className={`flex items-start gap-2 ${bgCard} rounded-lg px-3 py-2 group ${hoverBg}`}
											>
												<input
													type="checkbox"
													checked={ac.completed}
													onChange={() => handleACToggle(index)}
													className="mt-1 w-4 h-4 rounded cursor-pointer accent-blue-600"
													disabled={saving}
												/>
												{editingACIndex === index ? (
													<input
														type="text"
														value={editingACText}
														onChange={(e) => setEditingACText(e.target.value)}
														onBlur={handleACEditSave}
														onKeyDown={(e) => {
															if (e.key === "Enter") handleACEditSave();
															if (e.key === "Escape") {
																setEditingACIndex(null);
																setEditingACText("");
															}
														}}
														className={`flex-1 ${inputBg} rounded px-2 py-0.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500`}
													/>
												) : (
													<span
														className={`flex-1 text-sm cursor-pointer ${ac.completed ? `${textMuted} line-through` : textSecondary}`}
														onClick={() => handleACEditStart(index)}
														tabIndex={0}
														role="button"
													>
														{ac.text}
													</span>
												)}
												<button
													type="button"
													onClick={() => handleACDelete(index)}
													className={`opacity-0 group-hover:opacity-100 ${textMuted} hover:text-red-500 p-1 transition-all`}
												>
													<Trash2 className="w-4 h-4" />
												</button>
											</div>
										))}
									</div>

									{addingAC ? (
										<div className={`mt-2 ${bgCard} rounded-lg px-3 py-2`}>
											<input
												ref={newACInputRef}
												type="text"
												value={newACText}
												onChange={(e) => setNewACText(e.target.value)}
												onKeyDown={(e) => {
													if (e.key === "Enter" && newACText.trim()) handleACAdd();
													if (e.key === "Escape") {
														setNewACText("");
														setAddingAC(false);
													}
												}}
												placeholder="Add an item..."
												className={`w-full ${inputBg} rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500`}
											/>
											<div className="flex gap-2 mt-2">
												<button
													type="button"
													onClick={handleACAdd}
													className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
													disabled={!newACText.trim()}
												>
													Add
												</button>
												<button
													type="button"
													onClick={() => {
														setNewACText("");
														setAddingAC(false);
													}}
													className={`px-3 py-1 ${textMuted} text-sm ${hoverBg} rounded`}
												>
													Cancel
												</button>
											</div>
										</div>
									) : (
										<button
											type="button"
											onClick={() => setAddingAC(true)}
											className={`mt-2 flex items-center gap-1 text-sm ${textMuted} ${hoverBg} px-3 py-2 rounded-lg w-full`}
										>
											<Plus className="w-4 h-4" />
											<span>Add an item</span>
										</button>
									)}
								</section>

								{/* Implementation Plan */}
								<section>
									<div className={`flex items-center gap-2 mb-3 ${textSecondary}`}>
										<FileText className="w-5 h-5" />
										<h3 className="font-semibold">Implementation Plan</h3>
									</div>
									{editingPlan ? (
										<div>
											<TiptapEditor
												markdown={plan}
												onChange={setPlan}
												placeholder="1. First step&#10;2. Second step&#10;3. Third step..."
												readOnly={saving}
											/>
											<div className="flex gap-2 mt-2">
												<button
													type="button"
													onClick={handlePlanSave}
													className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
													disabled={saving}
												>
													Save
												</button>
												<button
													type="button"
													onClick={() => {
														setPlan(task.implementationPlan || "");
														setEditingPlan(false);
													}}
													className={`px-4 py-1.5 ${textMuted} text-sm ${hoverBg} rounded`}
												>
													Cancel
												</button>
											</div>
										</div>
									) : (
										<div
											className={`${bgCard} rounded-lg px-3 py-2 min-h-16 cursor-pointer ${hoverBg} border ${borderColor} overflow-hidden`}
											onClick={() => setEditingPlan(true)}
											tabIndex={0}
											role="button"
										>
											{task.implementationPlan ? (
												<EditorRender
													markdown={task.implementationPlan}
													className={`text-sm ${textSecondary}`}
												/>
											) : (
												<span className={`${textMuted} italic text-sm`}>
													Add implementation plan...
												</span>
											)}
										</div>
									)}
								</section>

								{/* Implementation Notes */}
								<section>
									<div className={`flex items-center gap-2 mb-3 ${textSecondary}`}>
										<Pencil className="w-5 h-5" />
										<h3 className="font-semibold">Implementation Notes</h3>
									</div>
									{editingNotes ? (
										<div>
											<TiptapEditor
												markdown={notes}
												onChange={setNotes}
												placeholder="Add implementation notes..."
												readOnly={saving}
											/>
											<div className="flex gap-2 mt-2">
												<button
													type="button"
													onClick={handleNotesSave}
													className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
													disabled={saving}
												>
													Save
												</button>
												<button
													type="button"
													onClick={() => {
														setNotes(task.implementationNotes || "");
														setEditingNotes(false);
													}}
													className={`px-4 py-1.5 ${textMuted} text-sm ${hoverBg} rounded`}
												>
													Cancel
												</button>
											</div>
										</div>
									) : (
										<div
											className={`${bgCard} rounded-lg px-3 py-2 min-h-16 cursor-pointer ${hoverBg} border ${borderColor} overflow-hidden`}
											onClick={() => setEditingNotes(true)}
											tabIndex={0}
											role="button"
										>
											{task.implementationNotes ? (
												<EditorRender
													markdown={task.implementationNotes}
													className={`text-sm ${textSecondary}`}
												/>
											) : (
												<span className={`${textMuted} italic text-sm`}>Add notes...</span>
											)}
										</div>
									)}
								</section>

								{/* Related Documentation */}
								{(() => {
									// Parse markdown links from task content
									const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
									const docRefs: Array<{ text: string; filename: string }> = [];

									const allContent = [
										task.description || "",
										task.implementationPlan || "",
										task.implementationNotes || "",
									].join("\n");

									let match: RegExpExecArray | null;
									while ((match = linkPattern.exec(allContent)) !== null) {
										const target = match[2];
										// Skip external URLs
										if (target.startsWith("http://") || target.startsWith("https://")) {
											continue;
										}
										// Skip relative paths that go outside docs
										if (target.startsWith("../")) {
											continue;
										}
										// Skip task references (task-123, task-123.md, 123, 123.md)
										if (/^(task-)?\d+(\.md)?$/.test(target)) {
											continue;
										}

										let filename = target;
										// Remove leading ./ if present
										filename = filename.replace(/^\.\//, "");
										if (!filename.endsWith(".md")) {
											filename = `${filename}.md`;
										}

										docRefs.push({
											text: match[1],
											filename: filename,
										});
									}

									if (docRefs.length === 0) return null;

									// Deduplicate by filename
									const uniqueRefs = Array.from(
										new Map(docRefs.map((ref) => [ref.filename, ref])).values()
									);

									return (
										<section>
											<div className={`flex items-center gap-2 mb-3 ${textSecondary}`}>
												<FileText className="w-5 h-5" />
												<h3 className="font-semibold">Related Documentation</h3>
												<span className={`text-sm ${textMuted}`}>({uniqueRefs.length})</span>
											</div>
											<div className="space-y-2">
												{uniqueRefs.map((ref, index) => (
													<div
														key={index}
														className={`${bgCard} rounded-lg px-3 py-2 flex items-center gap-2 ${borderColor} border`}
													>
														<span className="text-blue-500">📄</span>
														<div className="flex-1 min-w-0">
															<p className={`text-sm font-medium ${textSecondary} truncate`}>
																{ref.text}
															</p>
															<p className={`text-xs ${textMuted} font-mono truncate`}>
																@.knowns/docs/{ref.filename}
															</p>
														</div>
													</div>
												))}
											</div>
										</section>
									);
								})()}

								{/* Time Tracking */}
								<section>
									<div className={`flex items-center gap-2 mb-3 ${textSecondary}`}>
										<Clock className="w-5 h-5" />
										<h3 className="font-semibold">Time Tracking</h3>
									</div>
									<div className={`${bgCard} rounded-lg p-3`}>
										<TimeTracker task={task} onUpdate={onUpdate} />
									</div>
								</section>

								{/* History */}
								<section>
									<TaskHistoryPanel taskId={task.id} />
								</section>
							</div>
						</ScrollArea>

						{/* Sidebar */}
						<ScrollArea className={`w-full md:w-64 ${isDark ? "bg-gray-750" : "bg-gray-50"} border-t md:border-t-0 md:border-l ${borderColor}`}>
							<div className="p-4 space-y-4">
								{/* Status */}
								<div>
									<label
										className={`block text-xs font-semibold ${textMuted} uppercase tracking-wide mb-2`}
									>
										Status
									</label>
									<select
										value={task.status}
										onChange={(e) => handleStatusChange(e.target.value as TaskStatus)}
										className={`w-full rounded-lg px-3 py-2 text-sm font-medium border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500 ${isDark ? currentStatus?.darkColor : currentStatus?.lightColor}`}
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
										value={task.priority}
										onChange={(e) => handlePriorityChange(e.target.value as TaskPriority)}
										className={`w-full rounded-lg px-3 py-2 text-sm font-medium border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500 ${isDark ? currentPriority?.darkColor : currentPriority?.lightColor}`}
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
									<AssigneeDropdown
										value={task.assignee || ""}
										onChange={(newAssignee) => {
											setAssignee(newAssignee);
											handleSave({ assignee: newAssignee || undefined });
										}}
										currentUser={currentUser}
										showGrabButton={false}
										container={contentRef.current}
									/>
								</div>

								{/* Labels */}
								<div>
									<label
										className={`block text-xs font-semibold ${textMuted} uppercase tracking-wide mb-2`}
									>
										Labels
									</label>
									<div className="flex flex-wrap gap-1 mb-2">
										{task.labels.map((label) => (
											<span
												key={label}
												className={`inline-flex items-center gap-1 text-xs ${isDark ? "bg-blue-900/50 text-blue-300" : "bg-blue-100 text-blue-700"} px-2 py-1 rounded-full group`}
											>
												{label}
												<button
													type="button"
													onClick={() => handleLabelRemove(label)}
													className="opacity-0 group-hover:opacity-100 hover:text-red-500"
												>
													×
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
													if (e.key === "Enter" && newLabel.trim()) handleLabelAdd();
													if (e.key === "Escape") {
														setNewLabel("");
														setAddingLabel(false);
													}
												}}
												placeholder="Label name"
												className={`w-full ${inputBg} rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500`}
											/>
											<div className="flex gap-2 mt-2">
												<button
													type="button"
													onClick={handleLabelAdd}
													className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
													disabled={!newLabel.trim()}
												>
													Add
												</button>
												<button
													type="button"
													onClick={() => {
														setNewLabel("");
														setAddingLabel(false);
													}}
													className={`px-3 py-1 ${textMuted} text-sm ${hoverBg} rounded`}
												>
													Cancel
												</button>
											</div>
										</div>
									) : (
										<button
											type="button"
											onClick={() => setAddingLabel(true)}
											className={`flex items-center gap-1 text-sm ${textMuted} ${hoverBg} px-2 py-1.5 rounded`}
										>
											<Plus className="w-4 h-4" />
											<span>Add label</span>
										</button>
									)}
								</div>

								{/* Parent Task */}
								{task.parent &&
									(() => {
										const parentTask = allTasks.find((t) => t.id === task.parent);
										if (!parentTask) return null;
										return (
											<div>
												<label
													className={`block text-xs font-semibold ${textMuted} uppercase tracking-wide mb-2`}
												>
													Parent Task
												</label>
												<button
													type="button"
													onClick={() => onNavigateToTask?.(parentTask.id)}
													className={`w-full flex items-center gap-2 ${bgCard} rounded-lg px-3 py-2 text-sm text-left ${hoverBg} border ${borderColor}`}
												>
													<ArrowUp className="w-4 h-4" />
													<div className="flex-1 min-w-0">
														<span className={`text-xs ${textMuted} font-mono`}>
															#{parentTask.id}
														</span>
														<p className={`${textSecondary} truncate`}>{parentTask.title}</p>
													</div>
												</button>
											</div>
										);
									})()}

								{/* Subtasks */}
								{task.subtasks.length > 0 && (
									<div>
										<label
											className={`block text-xs font-semibold ${textMuted} uppercase tracking-wide mb-2`}
										>
											Subtasks ({task.subtasks.length})
										</label>
										<div className="space-y-1 max-h-48 overflow-y-auto">
											{task.subtasks.map((subtaskId) => {
												const subtask = allTasks.find((t) => t.id === subtaskId);
												if (!subtask) return null;
												return (
													<button
														key={subtaskId}
														type="button"
														onClick={() => onNavigateToTask?.(subtaskId)}
														className={`w-full flex items-center gap-2 ${bgCard} rounded-lg px-3 py-2 text-sm text-left ${hoverBg} border ${borderColor}`}
													>
														<span
															className={`w-2 h-2 rounded-full ${subtask.status === "done" ? "bg-green-500" : "bg-gray-400"}`}
														/>
														<div className="flex-1 min-w-0">
															<span className={`text-xs ${textMuted} font-mono`}>
																#{subtask.id}
															</span>
															<p
																className={`truncate ${subtask.status === "done" ? `${textMuted} line-through` : textSecondary}`}
															>
																{subtask.title}
															</p>
														</div>
													</button>
												);
											})}
										</div>
									</div>
								)}

								<hr className={borderColor} />

								{/* Actions */}
								<div>
									<label
										className={`block text-xs font-semibold ${textMuted} uppercase tracking-wide mb-2`}
									>
										Actions
									</label>
									<div className="space-y-1">
										<button
											type="button"
											onClick={() => handleSave({ status: "done" })}
											className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left ${textMuted} ${hoverBg} rounded-lg`}
											disabled={saving || task.status === "done"}
										>
											<Archive className="w-4 h-4" />
											<span>Mark as Done</span>
										</button>
										{onDelete && (
											<button
												type="button"
												onClick={() => {
													if (confirm("Delete this task?")) onDelete(task.id);
												}}
												className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-red-500 ${isDark ? "hover:bg-red-900/30" : "hover:bg-red-50"} rounded-lg`}
												disabled={saving}
											>
												<Trash2 className="w-4 h-4" />
												<span>Delete Task</span>
											</button>
										)}
									</div>
								</div>
							</div>
						</ScrollArea>
					</div>

					{/* Footer */}
					<div
						className={`border-t ${borderColor} px-6 py-3 ${isDark ? "bg-gray-750" : "bg-gray-50"} text-xs ${textMuted} flex justify-between`}
					>
						<span>Created: {new Date(task.createdAt).toLocaleString()}</span>
						<span>Updated: {new Date(task.updatedAt).toLocaleString()}</span>
					</div>
				</div>
			</div>
		</dialog>
	);
}
