import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/ui/components/ui/knowns/blocks/page-header";
import {
	ChevronRight,
	GitBranch,
	Package,
	FolderOpen,
	Folder,
	Link,
	Loader2,
	Clock,
	FileText,
	Download,
	ArrowLeft,
} from "lucide-react";
import { TreeView, type TreeDataItem } from "../components/ui/TreeView";
import { importApi, type Import, type ImportDetail } from "../api/client";
import { useSSEEvent } from "../contexts/SSEContext";

// Import management was removed (D8, extended to the web API by TSR-0MM0QC): imports already in
// .knowns/imports stay listed and viewable here, and nothing on this page adds, syncs or removes them.

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
			return <Download className="w-5 h-5 text-muted-foreground" />;
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

export default function ImportsPage() {
	const [imports, setImports] = useState<Import[]>([]);
	const [loading, setLoading] = useState(true);
	const [selectedImport, setSelectedImport] = useState<ImportDetail | null>(null);
	const [selectedName, setSelectedName] = useState<string | null>(null);
	const [loadingDetail, setLoadingDetail] = useState(false);

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

	// Back to list
	const handleBack = useCallback(() => {
		setSelectedImport(null);
		setSelectedName(null);
	}, []);

	if (loading) {
		return (
			<div className="max-w-[960px] mx-auto px-6 py-10 flex items-center justify-center h-64">
				<div className="text-muted-foreground">Loading imports...</div>
			</div>
		);
	}

	return (
		<div className="max-w-[960px] mx-auto px-6 py-10 h-full overflow-auto">
			{loadingDetail ? (
				<div className="flex items-center justify-center h-64">
					<Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
				</div>
			) : selectedImport ? (
				/* Detail View */
				<>
					{/* Back button */}
					<button
						type="button"
						onClick={handleBack}
						className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
					>
						<ArrowLeft className="w-4 h-4" />
						Imports
					</button>

					{/* Import Header */}
					<div className="flex items-start gap-3 mb-8">
						<ImportTypeIcon type={selectedImport.type} />
						<div>
							<div className="flex items-center gap-2">
								<h1 className="text-3xl font-semibold tracking-tight">{selectedImport.name}</h1>
								{selectedImport.link && (
									<span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded">
										Symlinked
									</span>
								)}
							</div>
							<p className="text-muted-foreground text-sm mt-1 font-mono">
								{selectedImport.source}
							</p>
						</div>
					</div>

					{/* Metadata */}
					<div className="grid grid-cols-2 sm:grid-cols-3 gap-6 border-t border-border/40 pt-8">
						<div>
							<div className="text-xs text-muted-foreground mb-1">Type</div>
							<div className="font-medium capitalize">{selectedImport.type}</div>
						</div>
						{selectedImport.ref && (
							<div>
								<div className="text-xs text-muted-foreground mb-1">Ref</div>
								<div className="font-medium font-mono text-sm">{selectedImport.ref}</div>
							</div>
						)}
						{selectedImport.commit && (
							<div>
								<div className="text-xs text-muted-foreground mb-1">Commit</div>
								<div className="font-medium font-mono text-sm">{selectedImport.commit}</div>
							</div>
						)}
						{selectedImport.version && (
							<div>
								<div className="text-xs text-muted-foreground mb-1">Version</div>
								<div className="font-medium">{selectedImport.version}</div>
							</div>
						)}
						<div>
							<div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
								<Clock className="w-3 h-3" />
								Last Sync
							</div>
							<div className="font-medium">{formatDate(selectedImport.lastSync)}</div>
						</div>
						<div>
							<div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
								<FileText className="w-3 h-3" />
								Files
							</div>
							<div className="font-medium">{selectedImport.fileCount} files</div>
						</div>
					</div>

					{/* Files */}
					<div className="border-t border-border/40 pt-8 mt-8">
						<h3 className="text-lg font-semibold mb-3">Imported Files</h3>
						<div className="rounded-lg border border-border/40 max-h-80 overflow-y-auto">
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
				</>
			) : (
				/* List View */
				<>
					<PageHeader
						className="mb-6 bg-transparent"
						title="Imports"
						titleText="Imports"
						description="Templates and docs imported earlier. Import management was removed; these stay readable and searchable."
						condense={false}
					/>

					{imports.length === 0 ? (
						<div className="py-16 text-center">
							<Download className="w-12 h-12 mx-auto text-muted-foreground" />
							<p className="mt-2 font-medium">No imports</p>
							<p className="text-sm text-muted-foreground mt-1">
								This project has no imported templates or docs.
							</p>
						</div>
					) : (
						<div className="space-y-0">
							{imports.map((imp) => (
								<button
									key={imp.name}
									type="button"
									onClick={() => loadImportDetail(imp.name)}
									className="w-full text-left px-3 py-3.5 -mx-3 flex items-center gap-4 hover:bg-muted/50 rounded-md transition-colors group"
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
									</div>
									<div className="text-xs text-muted-foreground text-right shrink-0 hidden sm:block">
										<div>{imp.fileCount} files</div>
										<div>{formatDate(imp.lastSync)}</div>
									</div>
									<ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-(--kn-dur-fast) ease-(--kn-ease-out)" />
								</button>
							))}
						</div>
					)}
				</>
			)}
		</div>
	);
}
