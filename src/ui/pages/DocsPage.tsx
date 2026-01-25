import { useCallback, useEffect, useRef, useState } from "react";
import {
	Plus,
	FileText,
	Folder,
	FolderOpen,
	ChevronRight,
	ChevronDown,
	Pencil,
	Check,
	X,
	Copy,
	Download,
	Package,
} from "lucide-react";
import { BlockNoteEditor, MDRender } from "../components/editor";
import { ScrollArea } from "../components/ui/scroll-area";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
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
	const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(["(root)", "__local__", "__imports__"]));
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

	// Auto-expand parent folders when a doc is selected
	useEffect(() => {
		if (!selectedDoc) return;

		setExpandedFolders((prev) => {
			const newExpanded = new Set(prev);

			// For imported docs, expand the imports section and source folder
			if (selectedDoc.isImported && selectedDoc.source) {
				newExpanded.add("__imports__");
				newExpanded.add(`__import_${selectedDoc.source}__`);

				// Get folder path within the import (e.g., "conventions" from "import-name/conventions/file.md")
				const pathWithoutImport = selectedDoc.path.replace(`${selectedDoc.source}/`, "");
				const parts = pathWithoutImport.split("/");
				if (parts.length > 1) {
					// Build folder paths within the import context
					const importPrefix = `__import_${selectedDoc.source}__`;
					let currentPath = importPrefix;
					for (let i = 0; i < parts.length - 1; i++) {
						currentPath = `${currentPath}/${parts.slice(0, i + 1).join("/")}`;
						newExpanded.add(currentPath);
					}
				}
			} else if (selectedDoc.folder) {
				// For local docs, expand parent folders
				const folderParts = selectedDoc.folder.split("/");
				let currentPath = "";
				for (const part of folderParts) {
					currentPath = currentPath ? `${currentPath}/${part}` : part;
					newExpanded.add(currentPath);
				}
			}

			return newExpanded;
		});
	}, [selectedDoc]);

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

	const toggleFolder = (folderPath: string) => {
		setExpandedFolders((prev) => {
			const newSet = new Set(prev);
			if (newSet.has(folderPath)) {
				newSet.delete(folderPath);
			} else {
				newSet.add(folderPath);
			}
			return newSet;
		});
	};

	// Build folder tree structure
	interface FolderNode {
		name: string;
		path: string;
		docs: Doc[];
		children: Map<string, FolderNode>;
		isImportRoot?: boolean;
	}

	const buildFolderTreeFromDocs = (docList: Doc[], pathPrefix = ""): FolderNode => {
		const root: FolderNode = {
			name: "(root)",
			path: pathPrefix,
			docs: [],
			children: new Map(),
		};

		for (const doc of docList) {
			// For imported docs, extract folder from the path after import name
			let folder = doc.folder;
			if (doc.isImported && doc.source) {
				// Path is like "import-name/patterns/xxx", folder should be "patterns"
				const pathWithoutImport = doc.path.replace(`${doc.source}/`, "");
				const parts = pathWithoutImport.split("/");
				folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
			}

			if (!folder) {
				root.docs.push(doc);
			} else {
				const parts = folder.split("/");
				let currentNode = root;

				for (let i = 0; i < parts.length; i++) {
					const part = parts[i];
					const pathSoFar = pathPrefix ? `${pathPrefix}/${parts.slice(0, i + 1).join("/")}` : parts.slice(0, i + 1).join("/");

					if (!currentNode.children.has(part)) {
						currentNode.children.set(part, {
							name: part,
							path: pathSoFar,
							docs: [],
							children: new Map(),
						});
					}

					currentNode = currentNode.children.get(part)!;
				}

				currentNode.docs.push(doc);
			}
		}

		return root;
	};

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

	// Count total docs in folder and subfolders
	const countDocs = (node: FolderNode): number => {
		let count = node.docs.length;
		for (const child of node.children.values()) {
			count += countDocs(child);
		}
		return count;
	};

	// Render folder tree recursively
	const renderFolderNode = (node: FolderNode, level = 0): JSX.Element[] => {
		const elements: JSX.Element[] = [];
		// Root is always expanded
		const isExpanded = level === 0 || expandedFolders.has(node.path);
		const paddingLeft = `${level * 16}px`;

		// Don't render root folder header
		if (level > 0) {
			const totalDocs = countDocs(node);
			elements.push(
				<button
					key={`folder-${node.path}`}
					type="button"
					onClick={() => toggleFolder(node.path)}
					className="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent text-foreground transition-colors"
					style={{ paddingLeft }}
				>
					{isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
					{isExpanded ? <FolderOpen className="w-4 h-4" /> : <Folder className="w-4 h-4" />}
					<span className="text-sm font-medium">{node.name}</span>
					<span className="text-xs text-muted-foreground">({totalDocs})</span>
				</button>
			);
		}

		// Render child folders and docs (if expanded or root)
		if (isExpanded || level === 0) {
			// Render child folders first
			const sortedChildren = Array.from(node.children.values()).sort((a, b) =>
				a.name.localeCompare(b.name)
			);
			for (const child of sortedChildren) {
				elements.push(...renderFolderNode(child, level + 1));
			}

			// Then render docs in this folder (sorted by title)
			const sortedDocs = [...node.docs].sort((a, b) =>
				a.metadata.title.localeCompare(b.metadata.title)
			);
			for (const doc of sortedDocs) {
				elements.push(
					<button
						key={`doc-${doc.path}`}
						type="button"
						onClick={() => {
							// Navigate using hash to update URL - normalize path for cross-platform
							window.location.hash = `/docs/${toDisplayPath(doc.path)}`;
						}}
						className={`w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-accent text-foreground transition-colors ${
							selectedDoc?.path === doc.path ? "bg-accent" : ""
						}`}
						style={{ paddingLeft: `${(level + 1) * 16}px` }}
					>
						<FileText className={`w-5 h-5 ${doc.isImported ? "text-blue-500" : ""}`} />
						<div className="flex-1 min-w-0">
							<div className="flex items-center gap-1.5">
								<span className="text-sm font-medium truncate">{doc.metadata.title}</span>
								{doc.isImported && (
									<span className="shrink-0 px-1 py-0.5 text-[10px] font-medium bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 rounded">
										imported
									</span>
								)}
							</div>
							{doc.metadata.description && (
								<div className="text-xs text-muted-foreground truncate">
									{doc.metadata.description}
								</div>
							)}
						</div>
					</button>
				);
			}
		}

		return elements;
	};

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
								<div>
									<button
										type="button"
										onClick={() => toggleFolder("__local__")}
										className="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent text-foreground transition-colors bg-muted/50"
									>
										{expandedFolders.has("__local__") ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
										<Folder className="w-4 h-4" />
										<span className="text-sm font-semibold">Local</span>
										<span className="text-xs text-muted-foreground">({localDocs.length})</span>
									</button>
									{expandedFolders.has("__local__") && renderFolderNode(buildFolderTreeFromDocs(localDocs))}
								</div>
							)}

							{/* Imported Docs Section */}
							{Object.keys(importsBySource).length > 0 && (
								<div>
									<button
										type="button"
										onClick={() => toggleFolder("__imports__")}
										className="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent text-foreground transition-colors bg-blue-50 dark:bg-blue-950/30"
									>
										{expandedFolders.has("__imports__") ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
										<Download className="w-4 h-4 text-blue-600 dark:text-blue-400" />
										<span className="text-sm font-semibold text-blue-700 dark:text-blue-300">Imports</span>
										<span className="text-xs text-blue-600 dark:text-blue-400">({importedDocs.length})</span>
									</button>
									{expandedFolders.has("__imports__") && (
										<div>
											{Object.entries(importsBySource).map(([source, sourceDocs]) => (
												<div key={source}>
													<button
														type="button"
														onClick={() => toggleFolder(`__import_${source}__`)}
														className="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent text-foreground transition-colors"
														style={{ paddingLeft: "16px" }}
													>
														{expandedFolders.has(`__import_${source}__`) ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
														<Package className="w-4 h-4 text-blue-500" />
														<span className="text-sm font-medium truncate">{source}</span>
														<span className="text-xs text-muted-foreground">({sourceDocs.length})</span>
													</button>
													{expandedFolders.has(`__import_${source}__`) && (
														<div style={{ paddingLeft: "16px" }}>
															{renderFolderNode(buildFolderTreeFromDocs(sourceDocs, `__import_${source}__`), 0)}
														</div>
													)}
												</div>
											))}
										</div>
									)}
								</div>
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
								<div className="flex-1 flex flex-col min-h-0 overflow-hidden">
									<div className="flex-1 p-6 min-h-0">
										<BlockNoteEditor
											markdown={editedContent}
											onChange={setEditedContent}
											placeholder="Write your documentation here..."
										/>
									</div>
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
								<div className="flex-1 min-h-[400px]">
									<BlockNoteEditor
										markdown={newDocContent}
										onChange={setNewDocContent}
										placeholder="Write your documentation here..."
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
