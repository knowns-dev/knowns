import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	Plus,
	FileText,
	Folder,
	FolderOpen,
	Pencil,
	Check,
	X,
	Copy,
	Download,
	Package,
} from "lucide-react";
import { MDEditor, MDRender } from "../components/editor";
import { ScrollArea } from "../components/ui/scroll-area";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { TreeView, type TreeDataItem } from "../components/ui/tree-view";
import { getDocs, createDoc, updateDoc } from "../api/client";
import { useSSEEvent } from "../contexts/SSEContext";
import { normalizePath, toDisplayPath, normalizePathForAPI } from "../lib/utils";

interface DocMetadata {
	title: string;
	description?: string;
	createdAt: string;
	updatedAt: string;
	tags?: string[];
}

interface Doc {
	filename: string;
	path: string;
	folder: string;
	metadata: DocMetadata;
	content: string;
	isImported?: boolean;
	source?: string;
}


export default function DocsPage() {
	const [docs, setDocs] = useState<Doc[]>([]);
	const [loading, setLoading] = useState(true);
	const [selectedDoc, setSelectedDoc] = useState<Doc | null>(null);
	const [isEditing, setIsEditing] = useState(false);
	const [editedContent, setEditedContent] = useState("");
	const [saving, setSaving] = useState(false);
	const [showCreateModal, setShowCreateModal] = useState(false);
	const [newDocTitle, setNewDocTitle] = useState("");
	const [newDocDescription, setNewDocDescription] = useState("");
	const [newDocTags, setNewDocTags] = useState("");
	const [newDocFolder, setNewDocFolder] = useState("");
	const [newDocContent, setNewDocContent] = useState("");
	const [creating, setCreating] = useState(false);
	const [pathCopied, setPathCopied] = useState(false);
	const markdownPreviewRef = useRef<HTMLDivElement>(null);

	// Initial docs load
	useEffect(() => {
		loadDocs();
	}, []);

	// Subscribe to SSE for real-time updates from CLI/AI
	useSSEEvent("docs:updated", () => {
		loadDocs();
	});

	useSSEEvent("docs:refresh", () => {
		loadDocs();
	});

	// Handle doc path from URL navigation (e.g., #/docs/patterns/controller.md)
	const handleHashNavigation = useCallback(() => {
		if (docs.length === 0) return;

		const hash = window.location.hash;
		// Match pattern: #/docs/{path}
		const match = hash.match(/^#\/docs\/(.+)$/);

		if (match) {
			const docPath = decodeURIComponent(match[1]);
			// Normalize path - convert backslashes to forward slashes and clean up
			const normalizedDocPath = normalizePath(docPath).replace(/^\.\//, "").replace(/^\//, "");
			// Also create a version without .md for comparison
			const normalizedDocPathNoExt = normalizedDocPath.replace(/\.md$/, "");

			// Find document - normalize both sides for comparison
			const targetDoc = docs.find((doc) => {
				const normalizedStoredPath = normalizePath(doc.path);
				const normalizedStoredPathNoExt = normalizedStoredPath.replace(/\.md$/, "");
				return (
					normalizedStoredPath === normalizedDocPath ||
					normalizedStoredPath === normalizedDocPathNoExt ||
					normalizedStoredPathNoExt === normalizedDocPath ||
					normalizedStoredPathNoExt === normalizedDocPathNoExt ||
					normalizedStoredPath.endsWith(`/${normalizedDocPath}`) ||
					normalizedStoredPath.endsWith(`/${normalizedDocPathNoExt}`) ||
					doc.filename === normalizedDocPath ||
					doc.filename === normalizedDocPathNoExt
				);
			});

			if (targetDoc && targetDoc !== selectedDoc) {
				setSelectedDoc(targetDoc);
				setIsEditing(false);
			}
		}
	}, [docs, selectedDoc]);

	// Handle initial load and docs change
	useEffect(() => {
		handleHashNavigation();
	}, [handleHashNavigation]);


	// Handle hash changes (when user navigates or changes URL)
	useEffect(() => {
		window.addEventListener("hashchange", handleHashNavigation);
		return () => window.removeEventListener("hashchange", handleHashNavigation);
	}, [handleHashNavigation]);

	// Handle markdown link clicks for internal navigation
	useEffect(() => {
		const handleLinkClick = (e: MouseEvent) => {
			let target = e.target as HTMLElement;

			// If clicked on SVG or child element, find parent anchor
			while (target && target.tagName !== "A" && target !== markdownPreviewRef.current) {
				target = target.parentElement as HTMLElement;
			}

			if (target && target.tagName === "A") {
				const anchor = target as HTMLAnchorElement;
				const href = anchor.getAttribute("href");

				// Handle task links (task-xxx or @task-xxx)
				if (href && /^@?task-[\w.]+(.md)?$/.test(href)) {
					e.preventDefault();
					const taskId = href.replace(/^@/, "").replace(".md", "");

					// Navigate to tasks page with hash
					window.location.hash = `/tasks?task=${taskId}`;
					return;
				}

				// Handle @doc/xxx format links
				if (href && href.startsWith("@doc/")) {
					e.preventDefault();
					const docPath = href.replace("@doc/", "");
					window.location.hash = `/docs/${docPath}.md`;
					return;
				}

				// Handle document links (.md extension)
				if (href && (href.endsWith(".md") || href.includes(".md#"))) {
					e.preventDefault();

					// Normalize the path (remove leading ./, ../, etc.)
					let docPath = href.replace(/^\.\//, "").replace(/^\//, "");

					// Remove anchor if present
					docPath = docPath.split("#")[0];

					// Navigate using hash to update URL
					window.location.hash = `/docs/${docPath}`;
				}
			}
		};

		const previewEl = markdownPreviewRef.current;
		if (previewEl) {
			previewEl.addEventListener("click", handleLinkClick);
			return () => previewEl.removeEventListener("click", handleLinkClick);
		}
	}, [docs, selectedDoc]);

	const loadDocs = () => {
		getDocs()
			.then((docs) => {
				setDocs(docs as Doc[]);
				setLoading(false);
			})
			.catch((err) => {
				console.error("Failed to load docs:", err);
				setLoading(false);
			});
	};

	const handleCreateDoc = async () => {
		if (!newDocTitle.trim()) {
			alert("Please enter a title");
			return;
		}

		setCreating(true);
		try {
			const tags = newDocTags
				.split(",")
				.map((t) => t.trim())
				.filter((t) => t);

			await createDoc({
				title: newDocTitle,
				description: newDocDescription,
				tags,
				folder: newDocFolder,
				content: newDocContent,
			});

			// Reset form
			setNewDocTitle("");
			setNewDocDescription("");
			setNewDocTags("");
			setNewDocFolder("");
			setNewDocContent("");
			setShowCreateModal(false);

			// Reload docs
			loadDocs();
		} catch (error) {
			console.error("Failed to create doc:", error);
			alert("Failed to create document. Please try again.");
		} finally {
			setCreating(false);
		}
	};

	const handleEdit = () => {
		if (selectedDoc) {
			setEditedContent(selectedDoc.content);
			setIsEditing(true);
		}
	};

	const handleCopyPath = () => {
		if (selectedDoc) {
			// Copy as @doc/... reference format (normalize path for cross-platform)
			const normalizedPath = toDisplayPath(selectedDoc.path).replace(/\.md$/, "");
			const refPath = `@doc/${normalizedPath}`;
			navigator.clipboard.writeText(refPath).then(() => {
				setPathCopied(true);
				setTimeout(() => setPathCopied(false), 2000);
			});
		}
	};

	const handleSave = async () => {
		if (!selectedDoc) return;

		setSaving(true);
		try {
			// Update doc via API - normalize path for cross-platform compatibility
			const updatedDoc = await updateDoc(normalizePathForAPI(selectedDoc.path), {
				content: editedContent,
			});

			// Update local state
			setDocs((prevDocs) =>
				prevDocs.map((doc) =>
					doc.path === selectedDoc.path
						? { ...doc, content: editedContent, metadata: { ...doc.metadata, updatedAt: new Date().toISOString() } }
						: doc
				)
			);
			setSelectedDoc((prev) => (prev ? { ...prev, content: editedContent } : prev));
			setIsEditing(false);
		} catch (error) {
			console.error("Failed to save doc:", error);
			alert(error instanceof Error ? error.message : "Failed to save document");
		} finally {
			setSaving(false);
		}
	};

	const handleCancel = () => {
		setIsEditing(false);
		setEditedContent("");
	};

	// Build TreeDataItem[] from docs
	const buildDocsTreeData = useCallback((docList: Doc[], onSelectDoc: (doc: Doc) => void): TreeDataItem[] => {
		interface TempNode {
			id: string;
			name: string;
			isDoc: boolean;
			doc?: Doc;
			children: Map<string, TempNode>;
		}

		const root: Map<string, TempNode> = new Map();

		for (const doc of docList) {
			// For imported docs, extract folder from the path after import name
			let folder = doc.folder;
			if (doc.isImported && doc.source) {
				const pathWithoutImport = doc.path.replace(`${doc.source}/`, "");
				const parts = pathWithoutImport.split("/");
				folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
			}

			const parts = folder ? folder.split("/") : [];
			let currentMap = root;

			// Build folder hierarchy
			for (let i = 0; i < parts.length; i++) {
				const part = parts[i];
				const currentPath = parts.slice(0, i + 1).join("/");

				if (!currentMap.has(part)) {
					currentMap.set(part, {
						id: currentPath,
						name: part,
						isDoc: false,
						children: new Map(),
					});
				}
				currentMap = currentMap.get(part)!.children;
			}

			// Add doc as leaf
			currentMap.set(doc.path, {
				id: doc.path,
				name: doc.metadata.title,
				isDoc: true,
				doc,
				children: new Map(),
			});
		}

		// Convert TempNode to TreeDataItem
		const convertToTreeData = (nodeMap: Map<string, TempNode>): TreeDataItem[] => {
			return Array.from(nodeMap.values())
				.sort((a, b) => {
					// Folders first, then docs
					if (a.isDoc !== b.isDoc) return a.isDoc ? 1 : -1;
					return a.name.localeCompare(b.name);
				})
				.map((node): TreeDataItem => {
					if (node.isDoc && node.doc) {
						return {
							id: node.id,
							name: node.name,
							icon: FileText,
							onClick: () => {
								window.location.hash = `/docs/${toDisplayPath(node.doc!.path)}`;
							},
						};
					}
					return {
						id: node.id,
						name: node.name,
						icon: Folder,
						openIcon: FolderOpen,
						children: node.children.size > 0 ? convertToTreeData(node.children) : undefined,
					};
				});
		};

		return convertToTreeData(root);
	}, []);

	// Separate local and imported docs
	const localDocs = docs.filter(d => !d.isImported);
	const importedDocs = docs.filter(d => d.isImported);

	// Group imported docs by source
	const importsBySource = importedDocs.reduce((acc, doc) => {
		const source = doc.source || "unknown";
		if (!acc[source]) acc[source] = [];
		acc[source].push(doc);
		return acc;
	}, {} as Record<string, Doc[]>);

	// Build tree data for local docs
	const localTreeData = useMemo(() =>
		buildDocsTreeData(localDocs, (doc) => {
			window.location.hash = `/docs/${toDisplayPath(doc.path)}`;
		}),
		[localDocs, buildDocsTreeData]
	);

	// Build tree data for each import source
	const importsTreeData = useMemo(() => {
		return Object.entries(importsBySource).map(([source, sourceDocs]): TreeDataItem => ({
			id: `__import_${source}__`,
			name: source,
			icon: Package,
			children: buildDocsTreeData(sourceDocs, (doc) => {
				window.location.hash = `/docs/${toDisplayPath(doc.path)}`;
			}),
		}));
	}, [importsBySource, buildDocsTreeData]);

	if (loading) {
		return (
			<div className="p-6 flex items-center justify-center h-64">
				<div className="text-lg text-muted-foreground">Loading documentation...</div>
			</div>
		);
	}

	return (
		<div className="p-6 h-full flex flex-col overflow-hidden">
			{/* Header */}
			<div className="mb-6 flex items-center justify-between">
				<h1 className="text-2xl font-bold">Documentation</h1>
				<Button
					onClick={() => setShowCreateModal(true)}
					className="bg-green-700 hover:bg-green-800 text-white"
				>
					<Plus className="w-4 h-4 mr-2" />
					New Document
				</Button>
			</div>

			<div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 min-h-0 overflow-hidden">
				{/* Doc List */}
				<div className="lg:col-span-1 flex flex-col min-h-0 overflow-hidden">
					<div className="bg-card rounded-lg border overflow-hidden flex flex-col flex-1 min-h-0">
						<div className="p-4 border-b shrink-0">
							<h2 className="font-semibold">All Documents ({docs.length})</h2>
						</div>
						<ScrollArea className="flex-1">
							{/* Local Docs Section */}
							{localDocs.length > 0 && (
								<TreeView
									data={{
										id: "__local__",
										name: `Local (${localDocs.length})`,
										icon: Folder,
										openIcon: FolderOpen,
										children: localTreeData,
									}}
									defaultNodeIcon={Folder}
									defaultLeafIcon={FileText}
									initialSelectedItemId={selectedDoc?.path}
								/>
							)}

							{/* Imported Docs Section */}
							{importsTreeData.length > 0 && (
								<TreeView
									data={{
										id: "__imports__",
										name: `Imports (${importedDocs.length})`,
										icon: Download,
										openIcon: Download,
										children: importsTreeData,
									}}
									defaultNodeIcon={Folder}
									defaultLeafIcon={FileText}
									initialSelectedItemId={selectedDoc?.path}
								/>
							)}
						</ScrollArea>
					</div>

					{docs.length === 0 && (
						<div className="bg-card rounded-lg border p-8 text-center">
							<FileText className="w-5 h-5" />
							<p className="mt-2 text-muted-foreground">No documentation found</p>
							<p className="text-sm text-muted-foreground mt-1">
								Create a doc with: <code className="font-mono">knowns doc create "Title"</code>
							</p>
						</div>
					)}
				</div>

				{/* Doc Content */}
				<div className="lg:col-span-2 flex flex-col min-h-0 overflow-hidden">
					{selectedDoc ? (
						<div className="bg-card rounded-lg border overflow-hidden flex flex-col flex-1 min-h-0">
							{/* Header */}
							<div className="p-6 border-b flex items-start justify-between shrink-0">
								<div className="flex-1">
									<div className="flex items-center gap-2 mb-2">
										<h2 className="text-2xl font-bold">
											{selectedDoc.metadata.title}
										</h2>
										{selectedDoc.isImported && (
											<span className="px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 rounded">
												Imported
											</span>
										)}
									</div>
									{selectedDoc.isImported && selectedDoc.source && (
										<p className="text-sm text-blue-600 dark:text-blue-400 mb-2">
											From: {selectedDoc.source}
										</p>
									)}
									{selectedDoc.metadata.description && (
										<p className="text-muted-foreground mb-2">{selectedDoc.metadata.description}</p>
									)}
									{/* Path display */}
									<button
										type="button"
										onClick={handleCopyPath}
										className="flex items-center gap-2 px-2 py-1 rounded text-xs text-blue-600 dark:text-blue-400 hover:bg-accent transition-colors group"
										title="Click to copy reference"
									>
										<Folder className="w-4 h-4" />
										<span className="font-mono">@doc/{toDisplayPath(selectedDoc.path).replace(/\.md$/, "")}</span>
										<span className="opacity-0 group-hover:opacity-100 transition-opacity">
											{pathCopied ? "✓ Copied!" : <Copy className="w-4 h-4" />}
										</span>
									</button>
									<div className="text-sm text-muted-foreground mt-2">
										Last updated: {new Date(selectedDoc.metadata.updatedAt).toLocaleString()}
									</div>
								</div>

								{/* Edit/Save/Cancel Buttons */}
								<div className="flex gap-2 ml-4">
									{!isEditing ? (
										<Button
											onClick={handleEdit}
											disabled={selectedDoc.isImported}
											title={selectedDoc.isImported ? "Imported docs are read-only" : "Edit document"}
										>
											<Pencil className="w-4 h-4 mr-2" />
											Edit
										</Button>
									) : (
										<>
											<Button
												onClick={handleSave}
												disabled={saving}
												className="bg-green-700 hover:bg-green-800 text-white"
											>
												<Check className="w-4 h-4 mr-2" />
												{saving ? "Saving..." : "Save"}
											</Button>
											<Button
												variant="secondary"
												onClick={handleCancel}
												disabled={saving}
											>
												<X className="w-4 h-4 mr-2" />
												Cancel
											</Button>
										</>
									)}
								</div>
							</div>

							{/* Content */}
							{isEditing ? (
								<div className="flex-1 min-h-0 overflow-hidden p-6">
									<MDEditor
										markdown={editedContent}
										onChange={setEditedContent}
										placeholder="Write your documentation here..."
										height="100%"
										className="h-full"
									/>
								</div>
							) : (
								<ScrollArea className="flex-1">
									<div className="p-6 prose prose-sm dark:prose-invert max-w-none" ref={markdownPreviewRef}>
										<MDRender
											markdown={selectedDoc.content || ""}
										/>
									</div>
								</ScrollArea>
							)}
						</div>
					) : (
						<div className="bg-card rounded-lg border p-12 text-center">
							<FileText className="w-5 h-5" />
							<p className="mt-4 text-muted-foreground">Select a document to view its content</p>
						</div>
					)}
				</div>
			</div>

			{/* Create Document Modal */}
			{showCreateModal && (
				<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
					<div className="bg-card rounded-lg shadow-xl max-w-4xl w-full h-[90vh] flex flex-col">
						<div className="p-6 border-b shrink-0">
							<h2 className="text-xl font-bold">Create New Document</h2>
						</div>

						<div className="p-6 space-y-4 flex-1 flex flex-col overflow-hidden">
							{/* Title */}
							<div className="shrink-0">
								<label className="block text-sm font-medium mb-2">Title *</label>
								<Input
									type="text"
									value={newDocTitle}
									onChange={(e) => setNewDocTitle(e.target.value)}
									placeholder="Document title"
								/>
							</div>

							{/* Description */}
							<div className="shrink-0">
								<label className="block text-sm font-medium mb-2">Description</label>
								<Input
									type="text"
									value={newDocDescription}
									onChange={(e) => setNewDocDescription(e.target.value)}
									placeholder="Brief description"
								/>
							</div>

							{/* Folder */}
							<div className="shrink-0">
								<label className="block text-sm font-medium mb-2">
									Folder (optional)
								</label>
								<Input
									type="text"
									value={newDocFolder}
									onChange={(e) => setNewDocFolder(e.target.value)}
									placeholder="api/auth, guides, etc. (leave empty for root)"
								/>
							</div>

							{/* Tags */}
							<div className="shrink-0">
								<label className="block text-sm font-medium mb-2">
									Tags (comma-separated)
								</label>
								<Input
									type="text"
									value={newDocTags}
									onChange={(e) => setNewDocTags(e.target.value)}
									placeholder="guide, tutorial, api"
								/>
							</div>

							{/* Content */}
							<div className="flex-1 flex flex-col min-h-0">
								<label className="block text-sm font-medium mb-2">Content</label>
								<div className="flex-1 min-h-0">
									<MDEditor
										markdown={newDocContent}
										onChange={setNewDocContent}
										placeholder="Write your documentation here..."
										height="100%"
										className="h-full"
									/>
								</div>
							</div>
						</div>

						<div className="p-6 border-t flex justify-end gap-3 shrink-0">
							<Button
								variant="secondary"
								onClick={() => {
									setShowCreateModal(false);
									setNewDocTitle("");
									setNewDocDescription("");
									setNewDocTags("");
									setNewDocFolder("");
									setNewDocContent("");
								}}
								disabled={creating}
							>
								Cancel
							</Button>
							<Button
								onClick={handleCreateDoc}
								disabled={creating || !newDocTitle.trim()}
								className="bg-green-700 hover:bg-green-800 text-white"
							>
								{creating ? "Creating..." : "Create Document"}
							</Button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
