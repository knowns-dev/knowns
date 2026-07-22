import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { Task } from "@/ui/models/task";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";

interface TaskHardDeleteDialogProps {
	task: Task;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	loading?: boolean;
	error?: string | null;
	onConfirm: (reason: string) => void;
}

export function TaskHardDeleteDialog({ task, open, onOpenChange, loading, error, onConfirm }: TaskHardDeleteDialogProps) {
	const [reason, setReason] = useState("");
	const [confirmation, setConfirmation] = useState("");

	useEffect(() => {
		if (!open) {
			setReason("");
			setConfirmation("");
		}
	}, [open]);

	const valid = reason.trim().length > 0 && confirmation === task.id;
	return (
		<Dialog open={open} onOpenChange={(next) => !loading && onOpenChange(next)}>
			<DialogContent data-testid="task-hard-delete-dialog">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2 text-destructive">
						<AlertTriangle className="h-5 w-5" /> Permanently delete Task #{task.id}
					</DialogTitle>
					<DialogDescription>
						This removes the Task, Plan, Notes, references, and history. A content-free tombstone reserves the ID. This is separate from Archive and cannot be undone.
					</DialogDescription>
				</DialogHeader>
				{error && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
				<div className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="hard-delete-reason">Reason</Label>
						<Textarea
							id="hard-delete-reason"
							value={reason}
							onChange={(event) => setReason(event.target.value)}
							placeholder="Why must this Task be permanently removed?"
							disabled={loading}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="hard-delete-confirmation">Type {task.id} to confirm</Label>
						<Input
							id="hard-delete-confirmation"
							value={confirmation}
							onChange={(event) => setConfirmation(event.target.value)}
							autoComplete="off"
							disabled={loading}
						/>
					</div>
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>Cancel</Button>
					<Button variant="destructive" disabled={!valid || loading} onClick={() => onConfirm(reason.trim())}>
						{loading ? "Deleting…" : "Permanently delete"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
