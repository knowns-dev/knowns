import { useEffect, useState } from "react";
import { Brain, ExternalLink, Loader2 } from "lucide-react";

import { memoryApi, type MemoryEntry } from "../../../api/client";
import { navigateTo } from "../../../lib/navigation";
import { SourceLinkList, type SourceRef } from "../../molecules/SourceLinkList";
import { MDRenderWithHighlight } from "../../editor/MDRenderWithHighlight";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogTitle } from "../../ui/dialog";

interface MemoryPreviewDialogProps {
	memoryId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * Follow a resolvable source. Left out, sources still render but only urls
	 * are clickable — the host decides how a doc or task gets opened.
	 */
	onOpenSource?: (ref: Exclude<SourceRef, { kind: "url" } | { kind: "text" }>) => void;
}

export function MemoryPreviewDialog({ memoryId, open, onOpenChange, onOpenSource }: MemoryPreviewDialogProps) {
	const [memory, setMemory] = useState<MemoryEntry | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open || !memoryId) {
			setMemory(null);
			setError(null);
			return;
		}

		let cancelled = false;
		setLoading(true);
		setError(null);
		memoryApi
			.get(memoryId)
			.then((entry) => {
				if (!cancelled) setMemory(entry);
			})
			.catch((fetchError) => {
				if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : "Failed to load memory");
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, [memoryId, open]);

	const handleViewInMemories = () => {
		if (!memoryId) return;
		navigateTo(`/memory/${encodeURIComponent(memoryId)}`);
		onOpenChange(false);
	};

	const facts = memory
		? [memory.layer, memory.category, memory.status, memory.confidence && `${memory.confidence} confidence`].filter(
				Boolean,
			)
		: [];

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[90vh] w-[95vw] max-w-4xl flex-col gap-0 overflow-hidden border-border/60 bg-background/95 p-0 shadow-2xl">
				<DialogTitle className="sr-only">Memory Preview: {memoryId}</DialogTitle>

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

				{memory && !loading && !error && (
					<>
						<div className="shrink-0 border-b border-border/50 bg-muted/20 px-6 py-5">
							<div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
								<Brain className="h-3.5 w-3.5" />
								<span className="rounded-md bg-background px-2 py-1 font-mono text-[11px] shadow-sm">
									@memory/{memory.id}
								</span>
							</div>
							<h2 className="text-2xl font-semibold leading-tight tracking-tight">{memory.title}</h2>
							{facts.length > 0 && (
								<div className="mt-3 flex flex-wrap gap-1.5">
									{facts.map((fact) => (
										<span
											key={String(fact)}
											className="rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-muted-foreground"
										>
											{fact}
										</span>
									))}
								</div>
							)}
						</div>

						<div className="min-h-0 flex-1 overflow-y-auto bg-background">
							<div className="mx-auto max-w-2xl px-6 py-6">
								{memory.content ? (
									<MDRenderWithHighlight
										content={memory.content}
										lineHighlight={null}
										className="prose prose-sm max-w-none dark:prose-invert [&_h1]:text-2xl [&_h2]:text-xl [&_p]:leading-7"
									/>
								) : (
									<p className="text-sm italic text-muted-foreground">No content</p>
								)}
								{memory.sources && memory.sources.length > 0 && (
									<div className="mt-6 border-t border-border/50 pt-4">
										<div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
											Sources
										</div>
										<SourceLinkList
											sources={memory.sources}
											onOpen={
												onOpenSource
													? (ref) => {
															onOpenChange(false);
															onOpenSource(ref);
														}
													: undefined
											}
										/>
									</div>
								)}
							</div>
						</div>

						<div className="flex justify-end border-t border-border/50 bg-muted/10 px-6 py-3">
							<Button
								variant="outline"
								size="sm"
								onClick={handleViewInMemories}
								className="h-7 gap-1.5 rounded-md text-[11px]"
							>
								<ExternalLink className="h-4 w-4" />
								View in Memories
							</Button>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
