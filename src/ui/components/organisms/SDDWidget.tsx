/**
 * SDD Dashboard Widget
 * Displays Spec-Driven Development coverage stats, warnings, and passed checks
 */

import { useEffect, useState } from "react";
import {
	ClipboardCheck,
	CheckCircle2,
	AlertTriangle,
	ChevronDown,
	ChevronUp,
	FileText,
	ListChecks,
	RefreshCw,
} from "lucide-react";
import { getSDDStats, type SDDResult } from "../../api/client";
import { Button } from "../ui/button";
import { Progress } from "../ui/progress";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { cn } from "@/ui/lib/utils";

export default function SDDWidget() {
	const [data, setData] = useState<SDDResult | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [warningsOpen, setWarningsOpen] = useState(false);
	const [passedOpen, setPassedOpen] = useState(false);

	const loadStats = async () => {
		try {
			setLoading(true);
			setError(null);
			const result = await getSDDStats();
			setData(result);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load SDD stats");
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		loadStats();
	}, []);

	if (loading && !data) {
		return (
			<div className="bg-card rounded-lg border p-4 mb-4">
				<div className="flex items-center gap-2 text-muted-foreground">
					<RefreshCw className="w-4 h-4 animate-spin" />
					<span className="text-sm">Loading SDD stats...</span>
				</div>
			</div>
		);
	}

	if (error && !data) {
		return (
			<div className="bg-card rounded-lg border p-4 mb-4">
				<div className="flex items-center justify-between">
					<span className="text-sm text-destructive">{error}</span>
					<Button variant="ghost" size="sm" onClick={loadStats}>
						<RefreshCw className="w-4 h-4" />
					</Button>
				</div>
			</div>
		);
	}

	if (!data) return null;

	const { stats, warnings, passed } = data;
	const hasSpecs = stats.specs.total > 0;

	// Don't show widget if no specs exist
	if (!hasSpecs) return null;

	return (
		<div className="bg-card rounded-lg border p-4 mb-4">
			{/* Header */}
			<div className="flex items-center justify-between mb-3">
				<div className="flex items-center gap-2">
					<ClipboardCheck className="w-5 h-5 text-purple-600" />
					<span className="font-semibold text-sm">SDD Coverage</span>
				</div>
				<Button
					variant="ghost"
					size="sm"
					onClick={loadStats}
					disabled={loading}
					className="h-7 w-7 p-0"
				>
					<RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
				</Button>
			</div>

			{/* Stats Grid */}
			<div className="grid grid-cols-3 gap-3 mb-3">
				{/* Specs */}
				<div className="text-center p-2 bg-muted/50 rounded-lg">
					<div className="text-2xl font-bold">{stats.specs.total}</div>
					<div className="text-xs text-muted-foreground">Specs</div>
					<div className="text-xs mt-1">
						<span className="text-green-600">{stats.specs.approved + stats.specs.implemented} approved</span>
						{stats.specs.draft > 0 && (
							<span className="text-yellow-600 ml-1">/ {stats.specs.draft} draft</span>
						)}
					</div>
				</div>

				{/* Tasks */}
				<div className="text-center p-2 bg-muted/50 rounded-lg">
					<div className="text-2xl font-bold">{stats.tasks.total}</div>
					<div className="text-xs text-muted-foreground">Tasks</div>
					<div className="text-xs mt-1">
						<span className="text-green-600">{stats.tasks.done} done</span>
						{stats.tasks.inProgress > 0 && (
							<span className="text-yellow-600 ml-1">/ {stats.tasks.inProgress} active</span>
						)}
					</div>
				</div>

				{/* Coverage */}
				<div className="text-center p-2 bg-muted/50 rounded-lg">
					<div className={cn(
						"text-2xl font-bold",
						stats.coverage.percent >= 75 ? "text-green-600" :
						stats.coverage.percent >= 50 ? "text-yellow-600" : "text-red-600"
					)}>
						{stats.coverage.percent}%
					</div>
					<div className="text-xs text-muted-foreground">Linked</div>
					<div className="text-xs mt-1 text-muted-foreground">
						{stats.coverage.linked}/{stats.coverage.total} tasks
					</div>
				</div>
			</div>

			{/* Coverage Progress Bar */}
			<div className="mb-3">
				<div className="flex items-center justify-between text-xs mb-1">
					<span className="text-muted-foreground flex items-center gap-1">
						<ListChecks className="w-3 h-3" />
						Task-Spec Coverage
					</span>
					<span className={cn(
						stats.coverage.percent >= 75 ? "text-green-600" :
						stats.coverage.percent >= 50 ? "text-yellow-600" : "text-red-600"
					)}>
						{stats.coverage.linked}/{stats.coverage.total}
					</span>
				</div>
				<Progress value={stats.coverage.percent} className="h-2" />
			</div>

			{/* Warnings Section */}
			{warnings.length > 0 && (
				<Collapsible open={warningsOpen} onOpenChange={setWarningsOpen} className="mb-2">
					<CollapsibleTrigger className="flex items-center justify-between w-full py-1 text-sm hover:bg-muted/50 rounded px-2 -mx-2">
						<div className="flex items-center gap-2 text-yellow-600">
							<AlertTriangle className="w-4 h-4" />
							<span>{warnings.length} Warning{warnings.length > 1 ? "s" : ""}</span>
						</div>
						{warningsOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
					</CollapsibleTrigger>
					<CollapsibleContent>
						<div className="mt-2 space-y-1 max-h-32 overflow-y-auto">
							{warnings.slice(0, 10).map((w, i) => (
								<div
									key={`${w.entity}-${i}`}
									className="text-xs text-muted-foreground flex items-start gap-2 py-1"
								>
									<FileText className="w-3 h-3 mt-0.5 shrink-0" />
									<span>
										<span className="font-mono text-yellow-600">{w.entity}</span>: {w.message}
									</span>
								</div>
							))}
							{warnings.length > 10 && (
								<div className="text-xs text-muted-foreground italic">
									+{warnings.length - 10} more warnings
								</div>
							)}
						</div>
					</CollapsibleContent>
				</Collapsible>
			)}

			{/* Passed Section */}
			{passed.length > 0 && (
				<Collapsible open={passedOpen} onOpenChange={setPassedOpen}>
					<CollapsibleTrigger className="flex items-center justify-between w-full py-1 text-sm hover:bg-muted/50 rounded px-2 -mx-2">
						<div className="flex items-center gap-2 text-green-600">
							<CheckCircle2 className="w-4 h-4" />
							<span>{passed.length} Passed</span>
						</div>
						{passedOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
					</CollapsibleTrigger>
					<CollapsibleContent>
						<div className="mt-2 space-y-1 max-h-32 overflow-y-auto">
							{passed.map((p, i) => (
								<div
									key={`passed-${i}`}
									className="text-xs text-muted-foreground flex items-start gap-2 py-1"
								>
									<CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0 text-green-600" />
									<span>{p}</span>
								</div>
							))}
						</div>
					</CollapsibleContent>
				</Collapsible>
			)}
		</div>
	);
}
