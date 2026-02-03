import { useCallback, useEffect, useState } from "react";
import {
	Plus,
	RefreshCw,
	Trash2,
	ChevronRight,
	GitBranch,
	Package,
	FolderOpen,
	Folder,
	Link,
	AlertCircle,
	Check,
	X,
	Loader2,
	Clock,
	FileText,
	Download,
} from "lucide-react";
import { ScrollArea } from "../components/ui/scroll-area";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { TreeView, type TreeDataItem } from "../components/ui/tree-view";
import { importApi, type Import, type ImportDetail, type ImportResult } from "../api/client";
import { useSSEEvent } from "../contexts/SSEContext";
import { toast } from "../components/ui/sonner";

// Helper to format date
function formatDate(isoDate: string | undefined): string {
	if (!isoDate) return "Never";
	const date = new Date(isoDate);
	return date.toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

// Icon for import type
function ImportTypeIcon({ type }: { type: string }) {
	switch (type) {
		case "git":
			return <GitBranch className="w-5 h-5 text-orange-500" />;
		case "npm":
			return <Package className="w-5 h-5 text-red-500" />;
		case "local":
			return <FolderOpen className="w-5 h-5 text-blue-500" />;
		default:
			return <Download className="w-5 h-5 text-gray-500" />;
	}
}

// Build TreeDataItem[] from file paths
function buildFileTreeData(files: string[]): TreeDataItem[] {
	interface TempNode {
		id: string;
		name: string;
		isFile: boolean;
		children: Map<string, TempNode>;
	}

	const root: Map<string, TempNode> = new Map();

	for (const filePath of files) {
		const parts = filePath.split("/");
		let currentMap = root;

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isFile = i === parts.length - 1;
			const currentPath = parts.slice(0, i + 1).join("/");

			if (!currentMap.has(part)) {
				currentMap.set(part, {
					id: currentPath,
					name: part,
					isFile,
					children: new Map(),
				});
			}
			currentMap = currentMap.get(part)!.children;
		}
	}

	// Convert TempNode to TreeDataItem
	const convertToTreeData = (nodeMap: Map<string, TempNode>): TreeDataItem[] => {
		return Array.from(nodeMap.values())
			.sort((a, b) => {
				// Folders first, then files
				if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
				return a.name.localeCompare(b.name);
			})
			.map((node): TreeDataItem => ({
				id: node.id,
				name: node.name,
				icon: node.isFile ? FileText : Folder,
				openIcon: node.isFile ? FileText : FolderOpen,
				children: node.children.size > 0 ? convertToTreeData(node.children) : undefined,
			}));
	};

	return convertToTreeData(root);
}

// Icon components for preview actions
const AddIcon = ({ className }: { className?: string }) => (
	<Check className={`${className} text-green-600`} />
);
const SkipIcon = ({ className }: { className?: string }) => (
	<X className={`${className} text-muted-foreground`} />
);

// Build TreeDataItem[] from import preview changes
function buildPreviewTreeData(changes: Array<{ action: string; path: string }>): TreeDataItem[] {
	interface TempNode {
		id: string;
		name: string;
		isFile: boolean;
		action?: string;
		children: Map<string, TempNode>;
	}

	const root: Map<string, TempNode> = new Map();

	for (const change of changes) {
		const parts = change.path.split("/");
		let currentMap = root;

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isFile = i === parts.length - 1;
			const currentPath = parts.slice(0, i + 1).join("/");

			if (!currentMap.has(part)) {
				currentMap.set(part, {
					id: currentPath,
					name: part,
					isFile,
					action: isFile ? change.action : undefined,
					children: new Map(),
				});
			}
			currentMap = currentMap.get(part)!.children;
		}
	}

	// Convert TempNode to TreeDataItem
	const convertToTreeData = (nodeMap: Map<string, TempNode>): TreeDataItem[] => {
		return Array.from(nodeMap.values())
			.sort((a, b) => {
				// Folders first, then files
				if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
				return a.name.localeCompare(b.name);
			})
			.map((node): TreeDataItem => ({
				id: node.id,
				name: node.name,
				icon: node.isFile ? (node.action === "skip" ? SkipIcon : AddIcon) : Folder,
				openIcon: node.isFile ? (node.action === "skip" ? SkipIcon : AddIcon) : FolderOpen,
				children: node.children.size > 0 ? convertToTreeData(node.children) : undefined,
			}));
	};

	return convertToTreeData(root);
}

export default function ImportsPage() {
	const [imports, setImports] = useState<Import[]>([]);
	const [loading, setLoading] = useState(true);
	const [selectedImport, setSelectedImport] = useState<ImportDetail | null>(null);
	const [selectedName, setSelectedName] = useState<string | null>(null);
	const [loadingDetail, setLoadingDetail] = useState(false);

	// Add import state
	const [showAddModal, setShowAddModal] = useState(false);
	const [addSource, setAddSource] = useState("");
	const [addName, setAddName] = useState("");
	const [addType, setAddType] = useState<string>("");
	const [addRef, setAddRef] = useState("");
	const [addLink, setAddLink] = useState(false);
	const [addDryRun, setAddDryRun] = useState(true);
	const [adding, setAdding] = useState(false);
	const [addResult, setAddResult] = useState<ImportResult | null>(null);
	const [addError, setAddError] = useState<string | null>(null);

	// Sync state
	const [syncing, setSyncing] = useState<string | null>(null);
	const [syncingAll, setSyncingAll] = useState(false);
	const [syncResult, setSyncResult] = useState<ImportResult | null>(null);

	// Remove state
	const [removing, setRemoving] = useState<string | null>(null);
	const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
	const [removeDeleteFiles, setRemoveDeleteFiles] = useState(false);

	// Load imports
	const loadImports = useCallback(async () => {
		try {
			const data = await importApi.list();
			setImports(data.imports);
		} catch (err) {
			console.error("Failed to load imports:", err);
		} finally {
			setLoading(false);
		}
	}, []);

	// Initial load
	useEffect(() => {
		loadImports();
	}, [loadImports]);

	// SSE events
	useSSEEvent("imports:added", () => loadImports());
	useSSEEvent("imports:synced", () => loadImports());
	useSSEEvent("imports:removed", () => {
		loadImports();
		if (selectedName) {
			setSelectedImport(null);
			setSelectedName(null);
		}
	});

	// Load import detail
	const loadImportDetail = async (name: string) => {
		setLoadingDetail(true);
		setSelectedName(name);
		setSyncResult(null);

		try {
			const data = await importApi.get(name);
			setSelectedImport(data.import);
		} catch (err) {
			console.error("Failed to load import:", err);
			setSelectedImport(null);
		} finally {
			setLoadingDetail(false);
		}
	};

	// Handle add import
	const handleAddImport = async () => {
		if (!addSource.trim()) return;

		setAdding(true);
		setAddError(null);
		setAddResult(null);

		try {
			const result = await importApi.add({
				source: addSource,
				name: addName || undefined,
				type: addType || undefined,
				ref: addRef || undefined,
				link: addLink,
				dryRun: addDryRun,
			});

			setAddResult(result);

			if (!addDryRun) {
				// Reload list
				loadImports();
				// Select the new import
				loadImportDetail(result.import.name);
			}
		} catch (err) {
			setAddError(err instanceof Error ? err.message : String(err));
		} finally {
			setAdding(false);
		}
	};

	// Handle sync
	const handleSync = async (name: string) => {
		setSyncing(name);
		setSyncResult(null);

		try {
			const result = await importApi.sync(name);
			setSyncResult(result);
			loadImports();
			if (selectedName === name) {
				loadImportDetail(name);
			}
			toast.success(`Synced "${name}"`, {
				description: `Added: ${result.summary.added}, Updated: ${result.summary.updated}, Skipped: ${result.summary.skipped}`,
			});
		} catch (err) {
			console.error("Failed to sync:", err);
			toast.error(`Failed to sync "${name}"`, {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setSyncing(null);
		}
	};

	// Handle sync all
	const handleSyncAll = async () => {
		setSyncingAll(true);
		try {
			const result = await importApi.syncAll();
			loadImports();
			if (selectedName) {
				loadImportDetail(selectedName);
			}
			const { summary } = result;
			if (summary.total === 0) {
				toast.info("No imports to sync");
			} else if (summary.failed > 0) {
				toast.warning(`Synced ${summary.successful} of ${summary.total} imports`, {
					description: `${summary.failed} failed`,
				});
			} else {
				toast.success(`Synced ${summary.successful} import${summary.successful > 1 ? "s" : ""}`, {
					description: "All imports are up to date",
				});
			}
		} catch (err) {
			console.error("Failed to sync all:", err);
			toast.error("Failed to sync imports", {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setSyncingAll(false);
		}
	};

	// Handle remove
	const handleRemove = async () => {
		if (!selectedName) return;

		setRemoving(selectedName);
		try {
			await importApi.remove(selectedName, removeDeleteFiles);
			setShowRemoveConfirm(false);
			setSelectedImport(null);
			setSelectedName(null);
			loadImports();
		} catch (err) {
			console.error("Failed to remove:", err);
		} finally {
			setRemoving(null);
		}
	};

	// Reset add form
	const resetAddForm = () => {
		setAddSource("");
		setAddName("");
		setAddType("");
		setAddRef("");
		setAddLink(false);
		setAddDryRun(true);
		setAddResult(null);
		setAddError(null);
		setShowAddModal(false);
	};

	if (loading) {
		return (
			<div className="p-6 flex items-center justify-center h-64">
				<div className="text-lg text-muted-foreground">Loading imports...</div>
			</div>
		);
	}

	return (
		<div className="p-6 h-full flex flex-col overflow-hidden">
			{/* Header */}
			<div className="mb-6 flex items-center justify-between">
				<div>
					<h1 className="text-2xl font-bold">Imports</h1>
					<p className="text-sm text-muted-foreground mt-1">
						Import templates and docs from external sources
					</p>
				</div>
				<div className="flex gap-2">
					<Button
						variant="outline"
						onClick={handleSyncAll}
						disabled={syncingAll || imports.length === 0}
					>
						{syncingAll ? (
							<Loader2 className="w-4 h-4 mr-2 animate-spin" />
						) : (
							<RefreshCw className="w-4 h-4 mr-2" />
						)}
						Sync All
					</Button>
					<Button
						onClick={() => setShowAddModal(true)}
						className="bg-green-700 hover:bg-green-800 text-white"
					>
						<Plus className="w-4 h-4 mr-2" />
						Add Import
					</Button>
				</div>
			</div>

			<div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 min-h-0 overflow-hidden">
				{/* Import List */}
				<div className="lg:col-span-1 flex flex-col min-h-0 overflow-hidden">
					<div className="bg-card rounded-lg border overflow-hidden flex flex-col flex-1 min-h-0">
						<div className="p-4 border-b shrink-0">
							<h2 className="font-semibold">Configured Imports ({imports.length})</h2>
						</div>
						<ScrollArea className="flex-1">
							{imports.map((imp) => (
								<button
									key={imp.name}
									type="button"
									onClick={() => loadImportDetail(imp.name)}
									className={`w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-accent text-foreground transition-colors border-b ${
										selectedName === imp.name ? "bg-accent" : ""
									}`}
								>
									<ImportTypeIcon type={imp.type} />
									<div className="flex-1 min-w-0">
										<div className="font-medium truncate flex items-center gap-2">
											{imp.name}
											{imp.link && (
												<Link className="w-3 h-3 text-muted-foreground" />
											)}
										</div>
										<div className="text-sm text-muted-foreground truncate">
											{imp.source}
										</div>
										<div className="text-xs text-muted-foreground mt-1">
											{imp.fileCount} files • Synced {formatDate(imp.lastSync)}
										</div>
									</div>
									<ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
								</button>
							))}
						</ScrollArea>
					</div>

					{imports.length === 0 && (
						<div className="bg-card rounded-lg border p-8 text-center">
							<Download className="w-12 h-12 mx-auto text-muted-foreground" />
							<p className="mt-2 font-medium">No imports yet</p>
							<p className="text-sm text-muted-foreground mt-1">
								Import templates and docs from git, npm, or local paths
							</p>
							<Button
								onClick={() => setShowAddModal(true)}
								className="mt-4"
								variant="outline"
							>
								<Plus className="w-4 h-4 mr-2" />
								Add your first import
							</Button>
						</div>
					)}
				</div>

				{/* Import Detail */}
				<div className="lg:col-span-2 flex flex-col min-h-0 overflow-hidden">
					{loadingDetail ? (
						<div className="bg-card rounded-lg border p-12 text-center">
							<Loader2 className="w-8 h-8 mx-auto animate-spin text-muted-foreground" />
							<div className="mt-2 text-muted-foreground">Loading import...</div>
						</div>
					) : selectedImport ? (
						<div className="bg-card rounded-lg border overflow-hidden flex flex-col flex-1 min-h-0">
							{/* Header */}
							<div className="p-6 border-b shrink-0 bg-gradient-to-r from-blue-50 to-transparent dark:from-blue-950/20">
								<div className="flex items-start justify-between gap-4">
									<div className="flex items-start gap-3">
										<ImportTypeIcon type={selectedImport.type} />
										<div>
											<div className="flex items-center gap-2">
												<h2 className="text-xl font-bold">{selectedImport.name}</h2>
												{selectedImport.link && (
													<span className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 px-2 py-0.5 rounded">
														Symlinked
													</span>
												)}
											</div>
											<p className="text-muted-foreground text-sm mt-1 font-mono">
												{selectedImport.source}
											</p>
										</div>
									</div>
									<div className="flex gap-2">
										<Button
											variant="outline"
											size="sm"
											onClick={() => handleSync(selectedImport.name)}
											disabled={syncing === selectedImport.name || selectedImport.link}
										>
											{syncing === selectedImport.name ? (
												<Loader2 className="w-4 h-4 animate-spin" />
											) : (
												<RefreshCw className="w-4 h-4" />
											)}
										</Button>
										<Button
											variant="outline"
											size="sm"
											className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
											onClick={() => setShowRemoveConfirm(true)}
										>
											<Trash2 className="w-4 h-4" />
										</Button>
									</div>
								</div>
							</div>

							<ScrollArea className="flex-1">
								<div className="p-6 space-y-6">
									{/* Metadata */}
									<div className="grid grid-cols-2 gap-4">
										<div className="space-y-1">
											<div className="text-sm text-muted-foreground">Type</div>
											<div className="font-medium capitalize">{selectedImport.type}</div>
										</div>
										{selectedImport.ref && (
											<div className="space-y-1">
												<div className="text-sm text-muted-foreground">Ref</div>
												<div className="font-medium font-mono">{selectedImport.ref}</div>
											</div>
										)}
										{selectedImport.commit && (
											<div className="space-y-1">
												<div className="text-sm text-muted-foreground">Commit</div>
												<div className="font-medium font-mono text-sm">{selectedImport.commit}</div>
											</div>
										)}
										{selectedImport.version && (
											<div className="space-y-1">
												<div className="text-sm text-muted-foreground">Version</div>
												<div className="font-medium">{selectedImport.version}</div>
											</div>
										)}
										<div className="space-y-1">
											<div className="text-sm text-muted-foreground flex items-center gap-1">
												<Clock className="w-3 h-3" />
												Last Sync
											</div>
											<div className="font-medium">{formatDate(selectedImport.lastSync)}</div>
										</div>
										<div className="space-y-1">
											<div className="text-sm text-muted-foreground flex items-center gap-1">
												<FileText className="w-3 h-3" />
												Files
											</div>
											<div className="font-medium">{selectedImport.fileCount} files</div>
										</div>
									</div>

									{/* Sync Result */}
									{syncResult && syncResult.import.name === selectedImport.name && (
										<div className="bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-lg p-4">
											<div className="flex items-start gap-2">
												<Check className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
												<div>
													<div className="font-medium text-green-800 dark:text-green-300">
														Sync Complete
													</div>
													<div className="text-sm text-green-700 dark:text-green-400 mt-1">
														Added: {syncResult.summary.added}, Updated: {syncResult.summary.updated}, Skipped: {syncResult.summary.skipped}
													</div>
													{syncResult.warnings && syncResult.warnings.length > 0 && (
														<div className="text-sm text-amber-600 dark:text-amber-400 mt-2">
															{syncResult.warnings.map((w, i) => (
																<div key={i}>⚠️ {w}</div>
															))}
														</div>
													)}
												</div>
											</div>
										</div>
									)}

									{/* Files - separated by type */}
									<div>
										<h3 className="font-semibold mb-3">Imported Files</h3>
										<div className="rounded-lg border bg-muted/30 max-h-80 overflow-y-auto">
											{selectedImport.files.length > 0 ? (
												(() => {
													// Separate files by type
													const templateFiles = selectedImport.files.filter(f => f.startsWith("templates/"));
													const docFiles = selectedImport.files.filter(f => f.startsWith("docs/"));
													const otherFiles = selectedImport.files.filter(f => !f.startsWith("templates/") && !f.startsWith("docs/"));

													const treeData: TreeDataItem[] = [];

													if (templateFiles.length > 0) {
														treeData.push({
															id: "__templates__",
															name: `Templates (${templateFiles.length})`,
															icon: Folder,
															openIcon: FolderOpen,
															children: buildFileTreeData(templateFiles.map(f => f.replace(/^templates\//, ""))),
														});
													}

													if (docFiles.length > 0) {
														treeData.push({
															id: "__docs__",
															name: `Docs (${docFiles.length})`,
															icon: Folder,
															openIcon: FolderOpen,
															children: buildFileTreeData(docFiles.map(f => f.replace(/^docs\//, ""))),
														});
													}

													if (otherFiles.length > 0) {
														treeData.push({
															id: "__other__",
															name: `Other (${otherFiles.length})`,
															icon: Folder,
															openIcon: FolderOpen,
															children: buildFileTreeData(otherFiles),
														});
													}

													return (
														<TreeView
															data={treeData}
															expandAll
															defaultNodeIcon={Folder}
															defaultLeafIcon={FileText}
														/>
													);
												})()
											) : (
												<div className="px-4 py-8 text-center text-muted-foreground">
													No files imported
												</div>
											)}
										</div>
									</div>
								</div>
							</ScrollArea>
						</div>
					) : (
						<div className="bg-card rounded-lg border p-12 text-center">
							<Download className="w-16 h-16 mx-auto text-muted-foreground/50" />
							<h3 className="mt-4 text-lg font-medium">Select an import</h3>
							<p className="mt-2 text-muted-foreground max-w-md mx-auto">
								Choose an import from the list to view details, sync, or remove it.
							</p>
						</div>
					)}
				</div>
			</div>

			{/* Add Import Modal */}
			{showAddModal && (
				<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
					<div className="bg-card rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
						<div className="p-6 border-b">
							<h2 className="text-xl font-bold">Add Import</h2>
							<p className="text-sm text-muted-foreground mt-1">
								Import templates and docs from an external source
							</p>
						</div>

						<div className="p-6 space-y-4">
							<div>
								<Label className="mb-2 block">
									Source <span className="text-red-500">*</span>
								</Label>
								<Input
									type="text"
									value={addSource}
									onChange={(e) => setAddSource(e.target.value)}
									placeholder="https://github.com/org/repo.git, @org/package, or ../path"
								/>
								<p className="text-xs text-muted-foreground mt-1">
									Git URL, npm package, or local path
								</p>
							</div>

							<div className="grid grid-cols-2 gap-4">
								<div>
									<Label className="mb-2 block">Name (optional)</Label>
									<Input
										type="text"
										value={addName}
										onChange={(e) => setAddName(e.target.value)}
										placeholder="Auto-detect from source"
									/>
								</div>
								<div>
									<Label className="mb-2 block">Type (optional)</Label>
									<select
										value={addType}
										onChange={(e) => setAddType(e.target.value)}
										className="w-full px-3 py-2 rounded-lg border bg-background"
									>
										<option value="">Auto-detect</option>
										<option value="git">Git</option>
										<option value="npm">NPM</option>
										<option value="local">Local</option>
									</select>
								</div>
							</div>

							<div>
								<Label className="mb-2 block">Ref (optional)</Label>
								<Input
									type="text"
									value={addRef}
									onChange={(e) => setAddRef(e.target.value)}
									placeholder="Branch, tag, or version"
								/>
							</div>

							<div className="flex items-center gap-4 p-3 rounded-lg border bg-muted/30">
								<Switch
									id="link"
									checked={addLink}
									onCheckedChange={setAddLink}
									disabled={addType !== "local" && !addSource.startsWith(".")}
								/>
								<Label htmlFor="link" className="text-sm cursor-pointer flex-1">
									<span className="font-medium">Symlink</span>
									<span className="text-muted-foreground ml-2">(local only)</span>
								</Label>
							</div>

							<div className="flex items-center gap-4 p-3 rounded-lg border bg-muted/30">
								<Switch
									id="dry-run"
									checked={addDryRun}
									onCheckedChange={setAddDryRun}
								/>
								<Label htmlFor="dry-run" className="text-sm cursor-pointer flex-1">
									<span className="font-medium">Preview mode</span>
									<span className="text-muted-foreground ml-2">(no files created)</span>
								</Label>
							</div>

							{/* Error */}
							{addError && (
								<div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg p-4">
									<div className="flex items-start gap-2 text-red-600 dark:text-red-400">
										<AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
										<div className="text-sm">{addError}</div>
									</div>
								</div>
							)}

							{/* Result */}
							{addResult && (
								<div
									className={`border rounded-lg p-4 ${
										addResult.dryRun
											? "bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800"
											: "bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800"
									}`}
								>
									<div className="flex items-start gap-2">
										{addResult.dryRun ? (
											<AlertCircle className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0" />
										) : (
											<Check className="w-5 h-5 text-green-600 shrink-0" />
										)}
										<div className="flex-1">
											<div className="font-medium">
												{addResult.dryRun ? "Preview Complete" : "Import Complete"}
											</div>
											<div className="text-sm text-muted-foreground mt-1">
												{addResult.summary.added} files to add, {addResult.summary.updated} to update, {addResult.summary.skipped} skipped
											</div>
											{addResult.dryRun && addResult.changes.length > 0 && (
												<div className="mt-3 max-h-48 overflow-y-auto rounded border bg-muted/30">
													{(() => {
														// Separate changes by type
														const templateChanges = addResult.changes.filter(c => c.path.startsWith("templates/"));
														const docChanges = addResult.changes.filter(c => c.path.startsWith("docs/"));
														const otherChanges = addResult.changes.filter(c => !c.path.startsWith("templates/") && !c.path.startsWith("docs/"));

														const treeData: TreeDataItem[] = [];

														if (templateChanges.length > 0) {
															treeData.push({
																id: "__templates__",
																name: `Templates (${templateChanges.length})`,
																icon: Folder,
																openIcon: FolderOpen,
																children: buildPreviewTreeData(templateChanges.map(c => ({ ...c, path: c.path.replace(/^templates\//, "") }))),
															});
														}

														if (docChanges.length > 0) {
															treeData.push({
																id: "__docs__",
																name: `Docs (${docChanges.length})`,
																icon: Folder,
																openIcon: FolderOpen,
																children: buildPreviewTreeData(docChanges.map(c => ({ ...c, path: c.path.replace(/^docs\//, "") }))),
															});
														}

														if (otherChanges.length > 0) {
															treeData.push({
																id: "__other__",
																name: `Other (${otherChanges.length})`,
																icon: Folder,
																openIcon: FolderOpen,
																children: buildPreviewTreeData(otherChanges),
															});
														}

														return (
															<TreeView
																data={treeData}
																expandAll
																defaultNodeIcon={Folder}
																defaultLeafIcon={FileText}
															/>
														);
													})()}
												</div>
											)}
											{addResult.dryRun && (
												<Button
													onClick={() => {
														setAddDryRun(false);
														handleAddImport();
													}}
													className="mt-3 bg-green-600 hover:bg-green-700 text-white"
													size="sm"
												>
													Import Now
												</Button>
											)}
										</div>
									</div>
								</div>
							)}
						</div>

						<div className="p-6 border-t flex justify-end gap-3">
							<Button variant="secondary" onClick={resetAddForm} disabled={adding}>
								{addResult && !addResult.dryRun ? "Close" : "Cancel"}
							</Button>
							{(!addResult || addResult.dryRun) && (
								<Button
									onClick={handleAddImport}
									disabled={adding || !addSource.trim()}
									className={addDryRun ? "" : "bg-green-600 hover:bg-green-700 text-white"}
								>
									{adding ? (
										<>
											<Loader2 className="w-4 h-4 mr-2 animate-spin" />
											{addDryRun ? "Checking..." : "Importing..."}
										</>
									) : addDryRun ? (
										"Preview"
									) : (
										"Import"
									)}
								</Button>
							)}
						</div>
					</div>
				</div>
			)}

			{/* Remove Confirmation Modal */}
			{showRemoveConfirm && selectedImport && (
				<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
					<div className="bg-card rounded-lg shadow-xl max-w-md w-full">
						<div className="p-6 border-b">
							<h2 className="text-xl font-bold text-red-600">Remove Import</h2>
						</div>

						<div className="p-6 space-y-4">
							<p>
								Are you sure you want to remove the import{" "}
								<strong>{selectedImport.name}</strong>?
							</p>

							<div className="flex items-center gap-4 p-3 rounded-lg border bg-muted/30">
								<Switch
									id="delete-files"
									checked={removeDeleteFiles}
									onCheckedChange={setRemoveDeleteFiles}
								/>
								<Label htmlFor="delete-files" className="text-sm cursor-pointer flex-1">
									<span className="font-medium">Also delete imported files</span>
									<span className="text-muted-foreground block text-xs mt-0.5">
										{selectedImport.fileCount} files will be permanently deleted
									</span>
								</Label>
							</div>
						</div>

						<div className="p-6 border-t flex justify-end gap-3">
							<Button
								variant="secondary"
								onClick={() => {
									setShowRemoveConfirm(false);
									setRemoveDeleteFiles(false);
								}}
								disabled={removing !== null}
							>
								Cancel
							</Button>
							<Button
								onClick={handleRemove}
								disabled={removing !== null}
								className="bg-red-600 hover:bg-red-700 text-white"
							>
								{removing ? (
									<>
										<Loader2 className="w-4 h-4 mr-2 animate-spin" />
										Removing...
									</>
								) : (
									"Remove"
								)}
							</Button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
