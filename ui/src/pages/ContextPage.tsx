import { useCallback, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { retrieve } from "@/ui/api/client";
import { Button as KnButton } from "@/ui/components/ui/knowns/button";
import { Input } from "@/ui/components/ui/knowns/input";
import { SegmentedControl } from "@/ui/components/ui/knowns/segmented-control";
import { ContextWindow } from "@/ui/components/ui/knowns/context-window/context-window";
import { ContextTreemap } from "@/ui/components/ui/knowns/context-treemap/context-treemap";
import { FeatureHeader } from "@/ui/components/templates";
import { PageContent, PageError, PageLoading, PageShell } from "@/ui/components/templates/PageShell";
import { TYPE_LABEL, packRows, packSegments, type PackRow } from "./context/contextPack";

type Mode = "hybrid" | "keyword" | "semantic";

const MODES = [
	{ value: "hybrid", label: "Hybrid" },
	{ value: "keyword", label: "Keyword" },
	{ value: "semantic", label: "Semantic" },
];

const BUDGETS = [
	{ value: "4000", label: "4k" },
	{ value: "8000", label: "8k" },
	{ value: "16000", label: "16k" },
	{ value: "32000", label: "32k" },
];

interface Result {
	query: string;
	rows: PackRow[];
}

export default function ContextPage() {
	const navigate = useNavigate();
	const [query, setQuery] = useState("");
	const [mode, setMode] = useState<Mode>("hybrid");
	const [budget, setBudget] = useState("8000");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<Result | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	const run = useCallback(
		async (q: string) => {
			abortRef.current?.abort();
			const controller = new AbortController();
			abortRef.current = controller;
			setLoading(true);
			setError(null);
			try {
				const data = await retrieve(q, { mode, limit: 20 }, controller.signal);
				if (controller.signal.aborted) return;
				setResult({ query: q, rows: packRows(data.contextPack.items, data.candidates) });
			} catch (caught) {
				if (controller.signal.aborted) return;
				setResult(null);
				setError(caught instanceof Error ? caught.message : "Failed to build the context pack");
			} finally {
				if (abortRef.current === controller) setLoading(false);
			}
		},
		[mode],
	);

	const submit = (e: FormEvent) => {
		e.preventDefault();
		const q = query.trim();
		if (q) void run(q);
	};

	const rows = result?.rows ?? [];
	const segments = useMemo(() => packSegments(rows), [rows]);
	const total = rows.reduce((sum, r) => sum + r.tokens, 0);
	const hrefs = useMemo(() => new Map(rows.map((r) => [r.key, r.href])), [rows]);

	return (
		<PageShell>
			<FeatureHeader
				title="Context pack"
				status={result ? `${rows.length} items, about ${total.toLocaleString()} tokens` : undefined}
			/>
			<PageContent>
				<form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-center" role="search">
					<div className="min-w-0 flex-1">
						<Input
							aria-label="Retrieve query"
							placeholder="What should the agent know? e.g. how auth works"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							icon={<Search />}
						/>
					</div>
					<SegmentedControl aria-label="Search mode" options={MODES} value={mode} onValueChange={(v) => setMode(v as Mode)} />
					<SegmentedControl aria-label="Token budget" options={BUDGETS} value={budget} onValueChange={setBudget} />
					<KnButton type="submit" disabled={!query.trim() || loading}>
						Build pack
					</KnButton>
				</form>

				<p className="mt-2 text-xs text-muted-foreground">
					Sizes are an estimate: about four characters per token. The budget is only what the pack is measured against.
				</p>

				<div className="mt-5" data-testid="context-result">
					{loading ? (
						<PageLoading label="Building the context pack" />
					) : error ? (
						<PageError title="Could not build the context pack" description={error} onRetry={() => void run(query.trim())} />
					) : !result ? (
						<p className="py-10 text-center text-sm text-muted-foreground">
							Run a query to see which docs, tasks, memories and decisions Knowns would put in an agent's context.
						</p>
					) : rows.length === 0 ? (
						<p className="py-10 text-center text-sm text-muted-foreground" role="status">
							Nothing matched "{result.query}". The pack is empty.
						</p>
					) : (
						<div className="flex flex-col gap-5">
							<ContextWindow segments={segments} limit={Number(budget)} title="Context pack" />
							<ContextTreemap
								segments={segments}
								limit={Number(budget)}
								title="What fills it"
								onOpen={(tile) => {
									const href = tile.partId ? hrefs.get(tile.partId) : null;
									if (href) void navigate({ to: href });
								}}
							/>
							<ul className="divide-y divide-border/60 rounded-lg border border-border/60" aria-label="Pack items">
								{rows.map((row) => (
									<li key={row.key} className="flex items-center gap-3 px-3 py-2 text-sm">
										<span className="w-20 shrink-0 text-xs text-muted-foreground">{TYPE_LABEL[row.type].replace(/s$/, "")}</span>
										<Link to={row.href ?? "/"} className="min-w-0 flex-1 truncate font-medium hover:underline">
											{row.title}
										</Link>
										<span className="shrink-0 tabular-nums text-xs text-muted-foreground">
											{row.score === null ? "" : `score ${row.score.toFixed(2)}`}
										</span>
										<span className="w-24 shrink-0 text-right tabular-nums text-xs text-muted-foreground">
											~{row.tokens.toLocaleString()} tokens
										</span>
									</li>
								))}
							</ul>
						</div>
					)}
				</div>
			</PageContent>
		</PageShell>
	);
}
