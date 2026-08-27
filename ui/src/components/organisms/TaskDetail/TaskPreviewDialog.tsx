import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogTitle } from "../../ui/dialog";
import { Button } from "../../ui/button";
import { CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import type { Task } from "@/ui/models/task";
import { getTask } from "../../../api/client";
import { navigateTo } from "../../../lib/navigation";
import MDRender from "../../editor/MDRender";

interface TaskPreviewDialogProps {
	taskId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

const STATUS_COLORS: Record<string, string> = {
	todo: "bg-gray-500",
	"in-progress": "bg-blue-500",
	"in-review": "bg-yellow-500",
	done: "bg-green-500",
	blocked: "bg-red-500",
	"on-hold": "bg-orange-500",
	urgent: "bg-red-600",
};

export function TaskPreviewDialog({
	taskId,
	open,
	onOpenChange,
}: TaskPreviewDialogProps) {
	const [task, setTask] = useState<Task | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open || !taskId) {
			setTask(null);
			setError(null);
			return;
		}

		setLoading(true);
		setError(null);

		getTask(taskId)
			.then((data) => {
				setTask(data);
			})
			.catch((err) => {
				setError(err instanceof Error ? err.message : "Failed to load task");
			})
			.finally(() => {
				setLoading(false);
			});
	}, [open, taskId]);

	const handleViewInKanban = () => {
		if (taskId) {
			navigateTo(`/tasks/${taskId}`);
			onOpenChange(false);
		}
	};

	const statusColor = task ? STATUS_COLORS[task.status] || "bg-gray-500" : "";
	const descriptionPreview = task?.description || "";
	const acceptanceCriteria = task?.acceptanceCriteria || [];
	const implementationPlan = task?.implementationPlan || "";
	const implementationNotes = task?.implementationNotes || "";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-3xl w-[95vw] p-0 gap-0 max-h-[90vh] overflow-hidden border-border/60 bg-background/95 shadow-2xl flex flex-col">
				<DialogTitle className="sr-only">
					Task Preview: {taskId}
				</DialogTitle>

				{loading && (
					<div className="flex items-center justify-center p-12">
						<Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
					</div>
				)}

				{error && (
					<div className="p-6 text-center">
						<p className="text-destructive">{error}</p>
					</div>
				)}

				{task && !loading && !error && (
					<>
						<div className="border-b border-border/50 bg-muted/20 px-6 py-5 shrink-0">
							<div className="mb-2 flex items-center gap-2">
								<span
									className={`h-2 w-2 rounded-full ${statusColor}`}
								/>
								<span className="rounded-md bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground shadow-sm">
									#{task.id}
								</span>
								<span className="rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-muted-foreground">
									{task.status}
								</span>
								{task.priority && (
									<span className="rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-muted-foreground">
										{task.priority}
									</span>
								)}
							</div>
							<h2 className="text-2xl font-semibold tracking-tight leading-tight">
								{task.title}
							</h2>
						</div>

						<div className="min-h-0 flex-1 overflow-y-auto bg-background">
							<div className="space-y-8 px-6 py-6">
								<section className="space-y-3">
									<h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Description</h3>
									{descriptionPreview ? (
										<MDRender
											markdown={descriptionPreview}
											className="prose prose-sm max-w-none dark:prose-invert [&_p]:leading-7"
										/>
									) : (
										<p className="text-sm italic text-muted-foreground">No description</p>
									)}
								</section>

								<section className="space-y-3">
									<div className="flex items-center gap-2">
										<h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Acceptance Criteria</h3>
										{acceptanceCriteria.length > 0 && (
											<span className="text-xs text-muted-foreground">
												{acceptanceCriteria.filter((item) => item.completed).length}/{acceptanceCriteria.length}
											</span>
										)}
									</div>
									{acceptanceCriteria.length > 0 ? (
										<div className="space-y-2">
											{acceptanceCriteria.map((item, index) => (
												<div
													key={`${task.id}-ac-${index}`}
													className="flex items-start gap-3 rounded-xl border border-border/60 bg-muted/10 px-3 py-2"
												>
													<CheckCircle2
														className={`mt-0.5 h-4 w-4 shrink-0 ${item.completed ? "text-emerald-500" : "text-muted-foreground/50"}`}
													/>
													<span className={`text-sm ${item.completed ? "text-muted-foreground line-through" : "text-foreground/90"}`}>
														{item.text}
													</span>
												</div>
											))}
										</div>
									) : (
										<p className="text-sm italic text-muted-foreground">No acceptance criteria</p>
									)}
								</section>

								<section className="space-y-3">
									<h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Implementation Plan</h3>
									{implementationPlan ? (
										<MDRender
											markdown={implementationPlan}
											className="prose prose-sm max-w-none dark:prose-invert [&_p]:leading-7"
										/>
									) : (
										<p className="text-sm italic text-muted-foreground">No implementation plan</p>
									)}
								</section>

								<section className="space-y-3">
									<h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Implementation Notes</h3>
									{implementationNotes ? (
										<MDRender
											markdown={implementationNotes}
											className="prose prose-sm max-w-none dark:prose-invert [&_p]:leading-7"
										/>
									) : (
										<p className="text-sm italic text-muted-foreground">No implementation notes</p>
									)}
								</section>
							</div>
						</div>

						<div className="flex justify-end border-t border-border/50 bg-muted/10 px-6 py-3">
							<Button
								variant="outline"
								size="sm"
								onClick={handleViewInKanban}
								className="h-7 gap-1.5 rounded-md text-[11px]"
							>
								<ExternalLink className="h-4 w-4" />
								View in Kanban
							</Button>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
