import { useState, useEffect, useCallback } from "react";
import { FolderOpen, Folder, Trash2, Search, ChevronRight, ArrowRightLeft, Clock, Loader2 } from "lucide-react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from "@/ui/components/ui/dialog";
import { Button } from "@/ui/components/ui/button";
import { workspaceApi, type WorkspaceProject, type DirEntry } from "@/ui/api/client";
import { cn } from "@/ui/lib/utils";

interface WorkspacePickerProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSwitched?: () => void;
}

function formatRelativeTime(dateStr: string): string {
	const date = new Date(dateStr);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMin = Math.floor(diffMs / 60000);
	if (diffMin < 1) return "just now";
	if (diffMin < 60) return `${diffMin}m ago`;
	const diffHr = Math.floor(diffMin / 60);
	if (diffHr < 24) return `${diffHr}h ago`;
	const diffDay = Math.floor(diffHr / 24);
	if (diffDay < 30) return `${diffDay}d ago`;
	return date.toLocaleDateString();
}

// ─── Saved tab ───────────────────────────────────────────────────────────────

function SavedTab({ onSwitch }: { onSwitch: (id: string) => Promise<void> }) {
	const [projects, setProjects] = useState<WorkspaceProject[]>([]);
	const [loading, setLoading] = useState(true);
	const [scanning, setScanning] = useState(false);
	const [switching, setSwitching] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			setProjects(await workspaceApi.list() || []);
		} catch {
			setError("Failed to load projects");
		} finally {
			setLoading(false);
		}
	}, []);

	const autoScan = useCallback(async () => {
		setScanning(true);
		try {
			await workspaceApi.autoScan();
			await load();
		} catch {
			// silent
		} finally {
			setScanning(false);
		}
	}, [load]);

	useEffect(() => { load(); autoScan(); }, [load, autoScan]);

	const handleSwitch = async (id: string) => {
		setSwitching(id);
		try { await onSwitch(id); } finally { setSwitching(null); }
	};

	const handleRemove = async (id: string) => {
		try {
			await workspaceApi.remove(id);
			setProjects(prev => prev.filter(p => p.id !== id));
		} catch {
			setError("Failed to remove project");
		}
	};

	return (
		<div className="flex flex-col gap-3">
			{error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
			{scanning && (
				<div className="flex items-center gap-2 text-xs text-muted-foreground">
					<Loader2 className="h-3 w-3 animate-spin" /> Scanning common directories…
				</div>
			)}
			<div className="max-h-72 overflow-y-auto space-y-1">
				{loading ? (
					<div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
				) : projects.length === 0 ? (
					<div className="py-8 text-center text-sm text-muted-foreground">
						No saved projects. Use Browse to find one.
					</div>
				) : projects.map(p => (
					<div
						key={p.id}
						className="group flex items-center gap-3 rounded-lg border px-3 py-2.5 hover:bg-accent/50 transition-colors cursor-pointer"
						onClick={() => handleSwitch(p.id)}
						onKeyDown={e => e.key === "Enter" && handleSwitch(p.id)}
						role="button"
						tabIndex={0}
					>
						<FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
						<div className="min-w-0 flex-1 overflow-hidden">
							<div className="truncate text-sm font-medium">{p.name}</div>
							<div className="truncate text-xs text-muted-foreground" title={p.path}>{p.path}</div>
						</div>
						<div className="flex items-center gap-1.5 shrink-0 ml-2">
							<span className="flex items-center gap-1 text-xs text-muted-foreground">
								<Clock className="h-3 w-3" />{formatRelativeTime(p.lastUsed)}
							</span>
							{switching === p.id && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
							<button
								type="button"
								className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 hover:text-destructive transition-[opacity,color,background-color] duration-(--kn-dur-fast) ease-(--kn-ease-out)"
								onClick={e => { e.stopPropagation(); handleRemove(p.id); }}
								aria-label={`Remove ${p.name}`}
							>
								<Trash2 className="h-3.5 w-3.5" />
							</button>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

// ─── Browse tab ───────────────────────────────────────────────────────────────

interface TreeNode {
	entry: DirEntry;
	children: TreeNode[] | null; // null = not loaded yet
	loading: boolean;
	expanded: boolean;
}

function buildNodes(entries: DirEntry[]): TreeNode[] {
	return entries.map(e => ({ entry: e, children: null, loading: false, expanded: false }));
}

function BrowseTab({ onSwitch }: { onSwitch: (path: string) => Promise<void> }) {
	const [roots, setRoots] = useState<TreeNode[]>([]);
	const [loading, setLoading] = useState(true);
	const [switching, setSwitching] = useState<string | null>(null);
	const [homePath, setHomePath] = useState<string>("");

	useEffect(() => {
		workspaceApi.browse().then(entries => {
			setRoots(buildNodes(entries));
			// Infer home from first entry's parent
			if (entries.length > 0 && entries[0]?.path) {
				const parts = entries[0].path.split("/");
				parts.pop();
				setHomePath(parts.join("/") || "/");
			}
		}).catch(() => {}).finally(() => setLoading(false));
	}, []);

	const toggleNode = useCallback(async (path: string[], nodeList: TreeNode[], setList: (n: TreeNode[]) => void) => {
		if (path.length === 0) return;

		const updateNodes = async (nodes: TreeNode[], depth: number): Promise<TreeNode[]> => {
			return Promise.all(nodes.map(async n => {
				if (n.entry.path !== path[depth]) return n;
				if (depth < path.length - 1) {
					// Recurse deeper
					return { ...n, children: n.children ? await updateNodes(n.children, depth + 1) : n.children };
				}
				// This is the target node
				if (n.expanded) return { ...n, expanded: false };
				if (n.children !== null) return { ...n, expanded: true };
				// Load children
				const loading = { ...n, loading: true, expanded: true };
				// We need to trigger a re-render with loading state first
				return loading;
			}));
		};

		// First pass: set loading
		const withLoading = await updateNodes(nodeList, 0);
		setList(withLoading);

		// Find the target node and load its children
		const targetPath = path[path.length - 1];
		const loadChildren = async (nodes: TreeNode[]): Promise<TreeNode[]> => {
			return Promise.all(nodes.map(async n => {
				if (n.entry.path === targetPath && n.loading) {
					try {
						const entries = await workspaceApi.browse(n.entry.path);
						return { ...n, loading: false, children: buildNodes(entries) };
					} catch {
						return { ...n, loading: false, children: [] };
					}
				}
				if (n.children) return { ...n, children: await loadChildren(n.children) };
				return n;
			}));
		};

		const withChildren = await loadChildren(withLoading);
		setList(withChildren);
	}, []);

	const handleSwitch = async (path: string) => {
		setSwitching(path);
		try { await onSwitch(path); } finally { setSwitching(null); }
	};

	const renderNodes = (nodes: TreeNode[], depth: number, pathSoFar: string[]): React.ReactNode => {
		return nodes.map(n => {
			const currentPath = [...pathSoFar, n.entry.path];
			return (
				<div key={n.entry.path}>
					<div
						className={cn(
							"flex items-center gap-1.5 rounded px-2 py-1.5 text-sm hover:bg-accent/50 transition-colors group",
							n.entry.isProject && "text-foreground"
						)}
						style={{ paddingLeft: `${8 + depth * 16}px` }}
					>
						{/* Expand chevron */}
						<button
							type="button"
							className={cn(
								"h-4 w-4 shrink-0 flex items-center justify-center rounded transition-colors",
								n.entry.hasChildren || n.entry.isProject ? "hover:bg-accent cursor-pointer" : "opacity-0 pointer-events-none"
							)}
							onClick={() => toggleNode(currentPath, roots, setRoots)}
						>
							{n.loading
								? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
								: <ChevronRight className={cn("h-3 w-3 text-muted-foreground transition-transform duration-(--kn-dur-fast) ease-(--kn-ease-inout)", n.expanded && "rotate-90")} />
							}
						</button>

						{/* Folder icon */}
						{n.entry.isProject
							? <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
							: <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
						}

						{/* Name */}
						<span
							className="flex-1 truncate cursor-pointer"
							onClick={() => n.entry.hasChildren && toggleNode(currentPath, roots, setRoots)}
						>
							{n.entry.name}
						</span>

						{/* Open button for projects */}
						{n.entry.isProject && (
							<Button
								size="sm"
								variant="default"
								className="h-6 px-2 text-xs opacity-0 group-hover:opacity-100 shrink-0"
								disabled={switching === n.entry.path}
								onClick={() => handleSwitch(n.entry.path)}
							>
								{switching === n.entry.path ? <Loader2 className="h-3 w-3 animate-spin" /> : "Open"}
							</Button>
						)}
					</div>

					{/* Children */}
					{n.expanded && n.children && n.children.length > 0 && (
						<div>{renderNodes(n.children, depth + 1, currentPath)}</div>
					)}
					{n.expanded && n.children && n.children.length === 0 && (
						<div className="text-xs text-muted-foreground py-1" style={{ paddingLeft: `${8 + (depth + 1) * 16}px` }}>
							Empty
						</div>
					)}
				</div>
			);
		});
	};

	return (
		<div className="flex flex-col gap-2">
			{homePath && (
				<div className="flex items-center gap-1.5 text-xs text-muted-foreground px-1">
					<Folder className="h-3 w-3" />
					<span className="truncate">{homePath}</span>
				</div>
			)}
			<div className="max-h-72 overflow-y-auto border rounded-lg">
				{loading ? (
					<div className="flex items-center justify-center py-8 gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" /> Loading…
					</div>
				) : roots.length === 0 ? (
					<div className="py-8 text-center text-sm text-muted-foreground">No directories found</div>
				) : (
					<div className="py-1">{renderNodes(roots, 0, [])}</div>
				)}
			</div>
			<p className="text-xs text-muted-foreground px-1">
				Folders with a <FolderOpen className="inline h-3 w-3 text-primary" /> icon contain a Knowns project.
			</p>
		</div>
	);
}

// ─── Main component ───────────────────────────────────────────────────────────

export function WorkspacePicker({ open, onOpenChange, onSwitched }: WorkspacePickerProps) {
	const [tab, setTab] = useState<"saved" | "browse">("saved");
	const [switching, setSwitching] = useState(false);

	const handleSwitchById = async (id: string) => {
		setSwitching(true);
		try {
			await workspaceApi.switchProject(id);
			onOpenChange(false);
			onSwitched?.();
		} catch (err) {
			console.error(err);
		} finally {
			setSwitching(false);
		}
	};

	const handleSwitchByPath = async (path: string) => {
		setSwitching(true);
		try {
			await workspaceApi.switchByPath(path);
			onOpenChange(false);
			onSwitched?.();
		} catch (err) {
			console.error(err);
		} finally {
			setSwitching(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<ArrowRightLeft className="h-5 w-5" />
						Switch Workspace
					</DialogTitle>
					<DialogDescription>
						Select a saved project or browse your filesystem.
					</DialogDescription>
				</DialogHeader>

				{/* Tabs */}
				<div className="flex gap-1 border-b">
					{(["saved", "browse"] as const).map(t => (
						<button
							key={t}
							type="button"
							className={cn(
								"px-3 py-1.5 text-sm font-medium capitalize transition-colors border-b-2 -mb-px",
								tab === t
									? "border-primary text-foreground"
									: "border-transparent text-muted-foreground hover:text-foreground"
							)}
							onClick={() => setTab(t)}
						>
							{t === "saved" ? "Saved" : "Browse"}
						</button>
					))}
				</div>

				{tab === "saved"
					? <SavedTab onSwitch={handleSwitchById} />
					: <BrowseTab onSwitch={handleSwitchByPath} />
				}

				{switching && (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" /> Switching workspace…
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
