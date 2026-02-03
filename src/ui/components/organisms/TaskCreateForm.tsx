import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlignLeft, ClipboardCheck, Plus, Trash2, ArrowUp, Maximize2, Minimize2, X, FileText, StickyNote } from "lucide-react";
import type { Task, TaskPriority, TaskStatus } from "@models/task";
import { useCurrentUser } from "../../contexts/UserContext";
import { useUIPreferences } from "../../contexts/UIPreferencesContext";
import { useConfig } from "../../contexts/ConfigContext";
import { createTask } from "../../api/client";
import { toast } from "../ui/sonner";
import AssigneeDropdown from "./AssigneeDropdown";
import { MDEditor } from "../editor";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetContent } from "../ui/sheet";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "../ui/popover";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "../ui/command";
import { cn } from "@/ui/lib/utils";
import { Check, ChevronsUpDown } from "lucide-react";
import { buildStatusOptions, getStatusBadgeClasses, type ColorName } from "../../utils/colors";

interface TaskCreateFormProps {
	isOpen: boolean;
	allTasks: Task[];
	onClose: () => void;
	onCreated: () => void;
}

const priorityOptions: { value: TaskPriority; label: string }[] = [
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
];

const priorityColors: Record<TaskPriority, string> = {
	low: "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400",
	medium: "bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300",
	high: "bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300",
};

export default function TaskCreateForm({
	isOpen,
	allTasks,
	onClose,
	onCreated,
}: TaskCreateFormProps) {
	const { currentUser } = useCurrentUser();
	const { config } = useConfig();
	const titleInputRef = useRef<HTMLInputElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);

	// Build status options from config
	const statusOptions = useMemo(() => {
		const statuses = config.statuses || ["todo", "in-progress", "in-review", "done", "blocked"];
		return buildStatusOptions(statuses);
	}, [config.statuses]);

	// Get status colors from config
	const configStatusColors = (config.statusColors || {}) as Record<string, ColorName>;

	// Form states
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [status, setStatus] = useState<TaskStatus>("todo");
	const [priority, setPriority] = useState<TaskPriority>("medium");
	const [assignee, setAssignee] = useState("");
	const [labels, setLabels] = useState<string[]>([]);
	const [parentId, setParentId] = useState<string>("");
	const [acceptanceCriteria, setAcceptanceCriteria] = useState<{ id: string; text: string }[]>([]);
	const [implementationPlan, setImplementationPlan] = useState("");
	const [implementationNotes, setImplementationNotes] = useState("");

	// UI states
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);
	const [newACText, setNewACText] = useState("");
	const [addingAC, setAddingAC] = useState(false);
	const [newLabel, setNewLabel] = useState("");
	const [addingLabel, setAddingLabel] = useState(false);
	const [parentComboOpen, setParentComboOpen] = useState(false);

	// Layout preference from context
	const { preferences, toggleTaskCreateLayout } = useUIPreferences();
	const isMaximized = preferences.taskCreateLayout === "maximized";

	const newACInputRef = useRef<HTMLInputElement>(null);

	// Animation variants
	const contentVariants = {
		hidden: { opacity: 0, y: 20, scale: 0.98 },
		visible: {
			opacity: 1,
			y: 0,
			scale: 1,
			transition: { duration: 0.2, ease: "easeOut" }
		},
		exit: {
			opacity: 0,
			y: 10,
			scale: 0.98,
			transition: { duration: 0.15, ease: "easeIn" }
		}
	};

	// Reset form when closed
	useEffect(() => {
		if (!isOpen) {
			setTitle("");
			setDescription("");
			setStatus("todo");
			setPriority("medium");
			setAssignee("");
			setLabels([]);
			setParentId("");
			setAcceptanceCriteria([]);
			setImplementationPlan("");
			setImplementationNotes("");
			setError(null);
			setSuccess(false);
			setNewACText("");
			setAddingAC(false);
			setNewLabel("");
			setAddingLabel(false);
			setParentComboOpen(false);
		}
	}, [isOpen]);

	// Focus title input when opened
	useEffect(() => {
		if (isOpen) {
			setTimeout(() => titleInputRef.current?.focus(), 100);
		}
	}, [isOpen, isMaximized]);

	useEffect(() => {
		if (addingAC && newACInputRef.current) newACInputRef.current.focus();
	}, [addingAC]);

	// AC handlers
	const handleACAdd = useCallback(() => {
		if (!newACText.trim()) return;
		setAcceptanceCriteria(prev => [
			...prev,
			{ id: crypto.randomUUID(), text: newACText.trim() },
		]);
		setNewACText("");
		setAddingAC(false);
	}, [newACText]);

	const handleACDelete = useCallback((id: string) => {
		setAcceptanceCriteria(prev => prev.filter((ac) => ac.id !== id));
	}, []);

	// Label handlers
	const handleLabelAdd = useCallback(() => {
		if (!newLabel.trim()) return;
		if (!labels.includes(newLabel.trim())) {
			setLabels(prev => [...prev, newLabel.trim()]);
		}
		setNewLabel("");
		setAddingLabel(false);
	}, [newLabel, labels]);

	const handleLabelRemove = useCallback((label: string) => {
		setLabels(prev => prev.filter((l) => l !== label));
	}, []);

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
				implementationPlan: implementationPlan.trim() || undefined,
				implementationNotes: implementationNotes.trim() || undefined,
			};

			await createTask(taskData);
			setSuccess(true);
			toast.success("Task created successfully", {
				description: title.trim(),
			});

			setTimeout(() => {
				onCreated();
				onClose();
			}, 800);
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : "Failed to create task";
			setError(errorMessage);
			toast.error("Failed to create task", {
				description: errorMessage,
			});
		} finally {
			setSaving(false);
		}
	};

	const parentTask = parentId ? allTasks.find((t) => t.id === parentId) : null;

	// Header component (shared)
	const Header = (
		<div className="flex items-center justify-between gap-2 p-4 border-b bg-green-700">
			<div className="flex-1 min-w-0">
				<span className="text-green-100 text-xs font-medium uppercase tracking-wide">New Task</span>
				<input
					ref={titleInputRef}
					type="text"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					placeholder="Enter task title..."
					className="w-full text-lg font-semibold bg-white/20 text-white placeholder-white/60 border-0 rounded px-2 py-1 mt-1 focus:outline-none focus:ring-2 focus:ring-white/50"
					disabled={saving}
				/>
			</div>
			<div className="flex items-center gap-1 shrink-0">
				<Button
					variant="ghost"
					size="icon"
					onClick={toggleTaskCreateLayout}
					className="h-8 w-8 text-foreground hover:text-foreground"
					title={isMaximized ? "Minimize" : "Maximize"}
				>
					{isMaximized ? (
						<Minimize2 className="w-4 h-4" />
					) : (
						<Maximize2 className="w-4 h-4" />
					)}
				</Button>
				<Button
					variant="ghost"
					size="icon"
					onClick={onClose}
					className="h-8 w-8 text-foreground hover:text-foreground"
					title="Close"
				>
					<X className="w-4 h-4" />
				</Button>
			</div>
		</div>
	);

	// Notifications component (shared)
	const Notifications = (success || error) && (
		<div className="px-4 pt-4">
			{success && (
				<div className="bg-green-50 dark:bg-green-900/50 border border-green-200 dark:border-green-700 text-green-700 dark:text-green-300 px-4 py-2 rounded-lg text-sm">
					Task created successfully!
				</div>
			)}
			{error && (
				<div className="bg-red-50 dark:bg-red-900/50 border border-red-200 dark:border-red-700 text-red-700 dark:text-red-300 px-4 py-2 rounded-lg text-sm">
					{error}
				</div>
			)}
		</div>
	);

	// Main content section (shared)
	const MainContent = (
		<div className="p-6 space-y-6">
			{/* Description */}
			<section>
				<div className="flex items-center gap-2 mb-3">
					<AlignLeft className="w-5 h-5 text-muted-foreground" />
					<h3 className="font-semibold text-sm text-muted-foreground">Description</h3>
				</div>
				<MDEditor
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
						<ClipboardCheck className="w-5 h-5 text-muted-foreground" />
						<h3 className="font-semibold text-sm text-muted-foreground">Acceptance Criteria</h3>
						{acceptanceCriteria.length > 0 && (
							<span className="text-xs text-muted-foreground">
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
							className="flex items-start gap-2 bg-muted/50 rounded-lg px-3 py-2 group hover:shadow-sm transition-shadow"
						>
							<input
								type="checkbox"
								checked={false}
								disabled
								className="mt-1 w-4 h-4 rounded cursor-not-allowed opacity-50"
							/>
							<span className="flex-1 text-sm">{ac.text}</span>
							<button
								type="button"
								onClick={() => handleACDelete(ac.id)}
								className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 p-1 transition-all"
								title="Delete"
							>
								<Trash2 className="w-4 h-4" />
							</button>
						</div>
					))}
				</div>

				{/* Add AC */}
				{addingAC ? (
					<div className="mt-2 bg-muted/50 rounded-lg px-3 py-2">
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
							className="w-full border border-input rounded px-2 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-green-500"
							disabled={saving}
						/>
						<div className="flex gap-2 mt-2">
							<Button
								type="button"
								size="sm"
								onClick={handleACAdd}
								disabled={!newACText.trim() || saving}
								className="bg-green-700 hover:bg-green-800 text-white"
							>
								Add
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => {
									setNewACText("");
									setAddingAC(false);
								}}
							>
								Cancel
							</Button>
						</div>
					</div>
				) : (
					<button
						type="button"
						onClick={() => setAddingAC(true)}
						className="mt-2 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:bg-muted px-3 py-2 rounded-lg transition-colors w-full"
						disabled={saving}
					>
						<Plus className="w-4 h-4" />
						<span>Add an item</span>
					</button>
				)}
			</section>

			{/* Implementation Plan */}
			<section>
				<div className="flex items-center gap-2 mb-3">
					<FileText className="w-5 h-5 text-muted-foreground" />
					<h3 className="font-semibold text-sm text-muted-foreground">Implementation Plan</h3>
					<span className="text-xs text-muted-foreground">(optional)</span>
				</div>
				<MDEditor
					markdown={implementationPlan}
					onChange={setImplementationPlan}
					placeholder="Describe how you plan to implement this task..."
					readOnly={saving}
				/>
			</section>

			{/* Implementation Notes */}
			<section>
				<div className="flex items-center gap-2 mb-3">
					<StickyNote className="w-5 h-5 text-muted-foreground" />
					<h3 className="font-semibold text-sm text-muted-foreground">Implementation Notes</h3>
					<span className="text-xs text-muted-foreground">(optional)</span>
				</div>
				<MDEditor
					markdown={implementationNotes}
					onChange={setImplementationNotes}
					placeholder="Add notes, observations, or any other relevant information..."
					readOnly={saving}
				/>
			</section>
		</div>
	);

	// Sidebar component (shared)
	const SidebarContent = (
		<div className="p-4 space-y-6">
			{/* Status */}
			<div className="space-y-2">
				<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Status
				</Label>
				<Select
					value={status}
					onValueChange={(value) => setStatus(value as TaskStatus)}
					disabled={saving}
				>
					<SelectTrigger className={cn("w-full", getStatusBadgeClasses(status, configStatusColors))}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{statusOptions.map((opt) => (
							<SelectItem key={opt.value} value={opt.value}>
								{opt.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{/* Priority */}
			<div className="space-y-2">
				<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Priority
				</Label>
				<Select
					value={priority}
					onValueChange={(value) => setPriority(value as TaskPriority)}
					disabled={saving}
				>
					<SelectTrigger className={cn("w-full", priorityColors[priority])}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{priorityOptions.map((opt) => (
							<SelectItem key={opt.value} value={opt.value}>
								{opt.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{/* Assignee */}
			<div className="space-y-2">
				<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Assignee
				</Label>
				<AssigneeDropdown
					value={assignee}
					onChange={setAssignee}
					showGrabButton={false}
					currentUser={currentUser}
					container={contentRef.current}
				/>
			</div>

			{/* Labels */}
			<div className="space-y-2">
				<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Labels
				</Label>
				<div className="flex flex-wrap gap-1">
					{labels.map((label) => (
						<Badge key={label} variant="secondary" className="gap-1 pr-1">
							{label}
							<button
								type="button"
								onClick={() => handleLabelRemove(label)}
								className="ml-1 hover:text-destructive"
							>
								<X className="w-3 h-3" />
							</button>
						</Badge>
					))}
				</div>
				{addingLabel ? (
					<div className="space-y-2">
						<Input
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
							disabled={saving}
							autoFocus
						/>
						<div className="flex gap-2">
							<Button size="sm" onClick={handleLabelAdd} disabled={!newLabel.trim() || saving}>
								Add
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onClick={() => {
									setNewLabel("");
									setAddingLabel(false);
								}}
							>
								Cancel
							</Button>
						</div>
					</div>
				) : (
					<Button
						variant="ghost"
						size="sm"
						className="w-full justify-start text-muted-foreground"
						onClick={() => setAddingLabel(true)}
						disabled={saving}
					>
						<Plus className="w-4 h-4 mr-2" />
						Add label
					</Button>
				)}
			</div>

			{/* Parent Task */}
			<div className="space-y-2">
				<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Parent Task
				</Label>
				<Popover open={parentComboOpen} onOpenChange={setParentComboOpen}>
					<PopoverTrigger asChild>
						<Button
							variant="outline"
							role="combobox"
							aria-expanded={parentComboOpen}
							className="w-full justify-between h-auto min-h-10 py-2"
							disabled={saving}
							title={parentTask ? `#${parentTask.id} - ${parentTask.title}` : undefined}
						>
							{parentTask ? (
								<div className="flex items-center gap-2 text-left overflow-hidden min-w-0 flex-1">
									<ArrowUp className="w-4 h-4 shrink-0 text-muted-foreground" />
									<div className="overflow-hidden min-w-0 flex-1">
										<span className="text-xs text-muted-foreground font-mono block">#{parentTask.id}</span>
										<p className="truncate text-sm">{parentTask.title}</p>
									</div>
								</div>
							) : (
								<span className="text-muted-foreground">Select parent task...</span>
							)}
							<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
						</Button>
					</PopoverTrigger>
					<PopoverContent className="w-[400px] p-0" align="start">
						<Command>
							<CommandInput placeholder="Search tasks..." />
							<CommandList>
								<CommandEmpty>No task found.</CommandEmpty>
								<CommandGroup>
									<CommandItem
										value="none"
										onSelect={() => {
											setParentId("");
											setParentComboOpen(false);
										}}
									>
										<Check
											className={cn(
												"mr-2 h-4 w-4 shrink-0",
												!parentId ? "opacity-100" : "opacity-0"
											)}
										/>
										<span className="text-muted-foreground">None</span>
									</CommandItem>
									{allTasks.map((t) => (
										<CommandItem
											key={t.id}
											value={`${t.id} ${t.title}`}
											onSelect={() => {
												setParentId(t.id);
												setParentComboOpen(false);
											}}
											title={`#${t.id} - ${t.title}`}
										>
											<Check
												className={cn(
													"mr-2 h-4 w-4 shrink-0",
													parentId === t.id ? "opacity-100" : "opacity-0"
												)}
											/>
											<div className="overflow-hidden min-w-0 flex-1">
												<span className="text-xs text-muted-foreground font-mono block">#{t.id}</span>
												<p className="truncate text-sm">{t.title}</p>
											</div>
										</CommandItem>
									))}
								</CommandGroup>
							</CommandList>
						</Command>
					</PopoverContent>
				</Popover>
			</div>
		</div>
	);

	// Footer component (shared)
	const Footer = (
		<div className="border-t px-6 py-4 bg-muted/30 flex justify-end gap-3">
			<Button
				type="button"
				variant="ghost"
				onClick={onClose}
				disabled={saving}
			>
				Cancel
			</Button>
			<Button
				type="button"
				onClick={handleSubmit}
				className="bg-green-700 hover:bg-green-800 text-white"
				disabled={saving || success || !title.trim()}
			>
				{saving ? "Creating..." : "Create Task"}
			</Button>
		</div>
	);

	// Centered Dialog mode (default) - Sidebar on RIGHT
	if (isMaximized) {
		return (
			<AnimatePresence>
				{isOpen && (
					<Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
						<DialogContent
							className="max-w-6xl w-[95vw] h-[90vh] p-0 gap-0 overflow-hidden flex flex-col"
							hideCloseButton
						>
							<DialogTitle className="sr-only">Create New Task</DialogTitle>
							<motion.div
								ref={contentRef}
								className="flex flex-col h-full overflow-hidden"
								variants={contentVariants}
								initial="hidden"
								animate="visible"
								exit="exit"
							>
								{Header}
								{Notifications}
								<div className="flex-1 flex overflow-hidden">
									{/* Main Content */}
									<ScrollArea className="flex-1">
										{MainContent}
									</ScrollArea>
									{/* Sidebar on right */}
									<div className="shrink-0 w-72 border-l bg-muted/20">
										<ScrollArea className="h-full">
											{SidebarContent}
										</ScrollArea>
									</div>
								</div>
								{Footer}
							</motion.div>
						</DialogContent>
					</Dialog>
				)}
			</AnimatePresence>
		);
	}

	// Side Sheet mode - Sidebar on TOP (compact)
	return (
		<AnimatePresence>
			{isOpen && (
				<Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
					<SheetContent
						side="right"
						className="w-full sm:max-w-2xl lg:max-w-3xl xl:max-w-4xl p-0 flex flex-col gap-0"
						hideCloseButton
					>
						<motion.div
							ref={contentRef}
							className="flex flex-col h-full overflow-hidden"
							variants={contentVariants}
							initial="hidden"
							animate="visible"
							exit="exit"
						>
							{Header}
							{Notifications}
							<div className="flex-1 flex flex-col overflow-hidden">
								{/* Sidebar on top - compact layout */}
								<div className="shrink-0 border-b bg-muted/20">
									<div className="p-4 space-y-3">
										{/* Row 1: Status, Priority, Assignee */}
										<div className="grid grid-cols-3 gap-3">
											<div className="space-y-1">
												<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
													Status
												</Label>
												<Select
													value={status}
													onValueChange={(value) => setStatus(value as TaskStatus)}
													disabled={saving}
												>
													<SelectTrigger className={cn("w-full h-9", getStatusBadgeClasses(status, configStatusColors))}>
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														{statusOptions.map((opt) => (
															<SelectItem key={opt.value} value={opt.value}>
																{opt.label}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
											</div>
											<div className="space-y-1">
												<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
													Priority
												</Label>
												<Select
													value={priority}
													onValueChange={(value) => setPriority(value as TaskPriority)}
													disabled={saving}
												>
													<SelectTrigger className={cn("w-full h-9", priorityColors[priority])}>
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														{priorityOptions.map((opt) => (
															<SelectItem key={opt.value} value={opt.value}>
																{opt.label}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
											</div>
											<div className="space-y-1">
												<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
													Assignee
												</Label>
												<AssigneeDropdown
													value={assignee}
													onChange={setAssignee}
													showGrabButton={false}
													currentUser={currentUser}
													container={contentRef.current}
												/>
											</div>
										</div>

										{/* Row 2: Labels + Parent Task */}
										<div className="flex items-start gap-4 flex-wrap">
											{/* Labels */}
											<div className="flex items-center gap-2 flex-wrap flex-1 min-w-0">
												<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground shrink-0">
													Labels:
												</Label>
												<div className="flex flex-wrap gap-1 flex-1">
													{labels.map((label) => (
														<Badge key={label} variant="secondary" className="gap-1 pr-1 text-xs">
															{label}
															<button
																type="button"
																onClick={() => handleLabelRemove(label)}
																className="ml-0.5 hover:text-destructive"
															>
																<X className="w-3 h-3" />
															</button>
														</Badge>
													))}
													{!addingLabel && (
														<Button
															variant="ghost"
															size="sm"
															className="h-6 px-2 text-xs text-muted-foreground"
															onClick={() => setAddingLabel(true)}
														>
															<Plus className="w-3 h-3 mr-1" />
															Add
														</Button>
													)}
												</div>
												{addingLabel && (
													<div className="flex items-center gap-2">
														<Input
															value={newLabel}
															onChange={(e) => setNewLabel(e.target.value)}
															onKeyDown={(e) => {
																if (e.key === "Enter" && newLabel.trim()) handleLabelAdd();
																if (e.key === "Escape") {
																	setNewLabel("");
																	setAddingLabel(false);
																}
															}}
															placeholder="Label"
															className="h-7 w-24 text-xs"
															autoFocus
														/>
														<Button size="sm" className="h-7 px-2" onClick={handleLabelAdd} disabled={!newLabel.trim()}>
															Add
														</Button>
														<Button
															size="sm"
															variant="ghost"
															className="h-7 px-2"
															onClick={() => {
																setNewLabel("");
																setAddingLabel(false);
															}}
														>
															<X className="w-3 h-3" />
														</Button>
													</div>
												)}
											</div>

											{/* Parent Task - compact */}
											<div className="flex items-center gap-2 shrink-0">
												<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground shrink-0">
													Parent:
												</Label>
												<Popover open={parentComboOpen} onOpenChange={setParentComboOpen}>
													<PopoverTrigger asChild>
														<Button
															variant="outline"
															role="combobox"
															size="sm"
															className="h-7 justify-between min-w-[120px] max-w-[250px]"
															disabled={saving}
															title={parentTask ? `#${parentTask.id} - ${parentTask.title}` : undefined}
														>
															{parentTask ? (
																<span className="truncate text-xs">
																	#{parentTask.id} - {parentTask.title}
																</span>
															) : (
																<span className="text-muted-foreground text-xs">None</span>
															)}
															<ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
														</Button>
													</PopoverTrigger>
													<PopoverContent className="w-[400px] p-0" align="end">
														<Command>
															<CommandInput placeholder="Search tasks..." />
															<CommandList>
																<CommandEmpty>No task found.</CommandEmpty>
																<CommandGroup>
																	<CommandItem
																		value="none"
																		onSelect={() => {
																			setParentId("");
																			setParentComboOpen(false);
																		}}
																	>
																		<Check
																			className={cn(
																				"mr-2 h-4 w-4 shrink-0",
																				!parentId ? "opacity-100" : "opacity-0"
																			)}
																		/>
																		<span className="text-muted-foreground">None</span>
																	</CommandItem>
																	{allTasks.map((t) => (
																		<CommandItem
																			key={t.id}
																			value={`${t.id} ${t.title}`}
																			onSelect={() => {
																				setParentId(t.id);
																				setParentComboOpen(false);
																			}}
																			title={`#${t.id} - ${t.title}`}
																		>
																			<Check
																				className={cn(
																					"mr-2 h-4 w-4 shrink-0",
																					parentId === t.id ? "opacity-100" : "opacity-0"
																				)}
																			/>
																			<div className="overflow-hidden min-w-0 flex-1">
																				<span className="text-xs text-muted-foreground font-mono block">#{t.id}</span>
																				<p className="truncate text-sm">{t.title}</p>
																			</div>
																		</CommandItem>
																	))}
																</CommandGroup>
															</CommandList>
														</Command>
													</PopoverContent>
												</Popover>
											</div>
										</div>
									</div>
								</div>
								{/* Main Content below */}
								<ScrollArea className="flex-1">
									{MainContent}
								</ScrollArea>
							</div>
							{Footer}
						</motion.div>
					</SheetContent>
				</Sheet>
			)}
		</AnimatePresence>
	);
}
