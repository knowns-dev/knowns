import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogTitle } from "../../ui/dialog";
import { ArrowUpRight } from "lucide-react";
import { Badge } from "@/ui/components/ui/knowns/badge";
import { Button } from "@/ui/components/ui/knowns/button";
import { Skeleton } from "@/ui/components/ui/knowns/skeleton";
import { useConfig } from "../../../contexts/ConfigContext";
import { getStatusLabel } from "../../../utils/colors";
import { DetailSection } from "./DetailSection";
import { formatTracked, priorityOptions, statusTone } from "./types";
import type { Task } from "@/ui/models/task";
import { getTask } from "../../../api/client";
import { navigateTo } from "../../../lib/navigation";
import MDRender from "../../editor/MDRender";

interface TaskPreviewDialogProps {
	taskId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function TaskPreviewDialog({
	taskId,
	open,
	onOpenChange,
}: TaskPreviewDialogProps) {
	const { config } = useConfig();
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

	const acceptanceCriteria = task?.acceptanceCriteria || [];
	const prose = "prose prose-sm max-w-[72ch] text-[14px] leading-relaxed dark:prose-invert [&>:first-child]:mt-0! [&>:last-child]:mb-0!";
	const markdown = (value: string | undefined, empty: string) =>
		value ? <MDRender markdown={value} className={prose} /> : <p className="text-[13.5px] text-muted-foreground">{empty}</p>;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[min(88vh,52rem)] w-[min(94vw,46rem)] max-w-none flex-col gap-0 overflow-hidden p-0">
				<DialogTitle className="sr-only">Task Preview: {task?.title ?? taskId}</DialogTitle>

				{loading && (
					<div className="flex flex-col gap-3 p-6" aria-busy="true" aria-label="Loading task">
						<Skeleton className="h-4 w-32" />
						<Skeleton className="h-7 w-3/4" />
						<Skeleton className="h-4 w-full" />
						<Skeleton className="h-4 w-5/6" />
					</div>
				)}

				{error && !loading && (
					<div role="alert" className="p-6 text-[14px]">
						<p className="font-medium text-foreground">Could not load task #{taskId}</p>
						<p className="mt-1 text-muted-foreground">{error}</p>
					</div>
				)}

				{task && !loading && !error && (
					<>
						<header className="flex flex-none flex-col gap-2 px-6 pt-6 pb-4 pr-14">
							<div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
								<span className="font-mono">#{task.id}</span>
								<Badge tone={statusTone(task.status, (config.statusColors || {}) as Record<string, string>)} dot shape="pill" size="sm">
									{getStatusLabel(task.status)}
								</Badge>
								<span>Priority {priorityOptions.find((p) => p.value === task.priority)?.label ?? task.priority}</span>
								{task.assignee && <span>{task.assignee}</span>}
								{task.timeSpent > 0 && <span className="tabular-nums">{formatTracked(task.timeSpent)} tracked</span>}
							</div>
							<h2 className="text-[22px] leading-tight font-semibold tracking-tight text-balance text-foreground">{task.title}</h2>
						</header>

						<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6">
							<div className="flex flex-col gap-8">
								<DetailSection title="Description">{markdown(task.description, "No description.")}</DetailSection>
								<DetailSection
									title="Acceptance Criteria"
									count={acceptanceCriteria.length > 0 ? `${acceptanceCriteria.filter((item) => item.completed).length}/${acceptanceCriteria.length}` : undefined}
								>
									{acceptanceCriteria.length > 0 ? (
										<ul className="flex flex-col">
											{acceptanceCriteria.map((item, index) => (
												<li key={`${task.id}-ac-${index}`} className="flex items-start gap-2.5 py-1.5 text-[14px] leading-snug">
													<span
														aria-hidden
														className={
															item.completed
																? "mt-0.5 grid size-4 flex-none place-items-center rounded-[5px] bg-[color:var(--kn-accent,var(--primary))] text-[color:var(--kn-accent-foreground,var(--primary-foreground))]"
																: "mt-0.5 size-4 flex-none rounded-[5px] shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_24%,transparent)]"
														}
													>
														{item.completed && (
															<svg viewBox="0 0 16 16" className="size-3">
																<path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
															</svg>
														)}
													</span>
													<span className={item.completed ? "text-muted-foreground line-through decoration-muted-foreground/50" : "text-foreground"}>
														{item.text}
														<span className="sr-only">{item.completed ? ", done" : ", open"}</span>
													</span>
												</li>
											))}
										</ul>
									) : (
										<p className="text-[13.5px] text-muted-foreground">No acceptance criteria.</p>
									)}
								</DetailSection>
								<DetailSection title="Implementation Plan">{markdown(task.implementationPlan, "No implementation plan.")}</DetailSection>
								<DetailSection title="Implementation Notes">{markdown(task.implementationNotes, "No implementation notes.")}</DetailSection>
							</div>
						</div>

						<footer className="flex flex-none justify-end border-t border-[color-mix(in_srgb,var(--foreground)_9%,transparent)] px-6 py-3">
							<Button size="sm" variant="secondary" iconRight={<ArrowUpRight />} onClick={handleViewInKanban}>
								Open task
							</Button>
						</footer>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
