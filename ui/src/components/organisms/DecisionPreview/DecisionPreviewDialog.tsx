import { useEffect, useState } from "react";
import { ExternalLink, Loader2, Scale } from "lucide-react";

import { decisionApi, type DecisionEntry } from "../../../api/client";
import { navigateTo } from "../../../lib/navigation";
import { MDRenderWithHighlight } from "../../editor/MDRenderWithHighlight";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogTitle } from "../../ui/dialog";

interface DecisionPreviewDialogProps {
	decisionId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/** The stored sections, in the order a decision record reads. */
function sectionsOf(decision: DecisionEntry): { title: string; body: string }[] {
	return [
		{ title: "Context", body: decision.context },
		{ title: "Decision", body: decision.decision },
		{ title: "Alternatives considered", body: decision.alternativesConsidered },
		{ title: "Consequences", body: decision.consequences },
	].filter((section): section is { title: string; body: string } => Boolean(section.body?.trim()));
}

export function DecisionPreviewDialog({ decisionId, open, onOpenChange }: DecisionPreviewDialogProps) {
	const [decision, setDecision] = useState<DecisionEntry | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open || !decisionId) {
			setDecision(null);
			setError(null);
			return;
		}

		let cancelled = false;
		setLoading(true);
		setError(null);
		decisionApi
			.get(decisionId)
			.then((entry) => {
				if (!cancelled) setDecision(entry);
			})
			.catch((fetchError) => {
				if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : "Failed to load decision");
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, [decisionId, open]);

	const handleViewInDecisions = () => {
		if (!decisionId) return;
		navigateTo(`/decisions/${encodeURIComponent(decisionId)}`);
		onOpenChange(false);
	};

	const sections = decision ? sectionsOf(decision) : [];

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[90vh] w-[95vw] max-w-4xl flex-col gap-0 overflow-hidden border-border/60 bg-background/95 p-0 shadow-2xl">
				<DialogTitle className="sr-only">Decision Preview: {decisionId}</DialogTitle>

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

				{decision && !loading && !error && (
					<>
						<div className="shrink-0 border-b border-border/50 bg-muted/20 px-6 py-5">
							<div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
								<Scale className="h-3.5 w-3.5" />
								<span className="rounded-md bg-background px-2 py-1 font-mono text-[11px] shadow-sm">
									@decision/{decision.id}
								</span>
							</div>
							<h2 className="text-2xl font-semibold leading-tight tracking-tight">{decision.title}</h2>
							<div className="mt-3 flex flex-wrap gap-1.5">
								<span className="rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-muted-foreground">
									{decision.status}
								</span>
								{decision.tags?.map((tag) => (
									<span
										key={tag}
										className="rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-muted-foreground"
									>
										{tag}
									</span>
								))}
							</div>
						</div>

						<div className="min-h-0 flex-1 overflow-y-auto bg-background">
							<div className="mx-auto max-w-2xl space-y-6 px-6 py-6">
								{sections.length > 0 ? (
									sections.map((section) => (
										<section key={section.title}>
											<div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
												{section.title}
											</div>
											<MDRenderWithHighlight
												content={section.body}
												lineHighlight={null}
												className="prose prose-sm max-w-none dark:prose-invert [&_h1]:text-2xl [&_h2]:text-xl [&_p]:leading-7"
											/>
										</section>
									))
								) : decision.content ? (
									<MDRenderWithHighlight
										content={decision.content}
										lineHighlight={null}
										className="prose prose-sm max-w-none dark:prose-invert [&_h1]:text-2xl [&_h2]:text-xl [&_p]:leading-7"
									/>
								) : (
									<p className="text-sm italic text-muted-foreground">No content</p>
								)}
							</div>
						</div>

						<div className="flex justify-end border-t border-border/50 bg-muted/10 px-6 py-3">
							<Button
								variant="outline"
								size="sm"
								onClick={handleViewInDecisions}
								className="h-7 gap-1.5 rounded-md text-[11px]"
							>
								<ExternalLink className="h-4 w-4" />
								View in Decisions
							</Button>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
