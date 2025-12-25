import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "../App";
import MarkdownEditor from "../components/MarkdownEditor";
import MarkdownRenderer from "../components/MarkdownRenderer";

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
}

const Icons = {
	Plus: () => (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
		</svg>
	),
	Document: () => (
		<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
			/>
		</svg>
	),
	Folder: () => (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
			/>
		</svg>
	),
	FolderOpen: () => (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z"
			/>
		</svg>
	),
	ChevronRight: () => (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
		</svg>
	),
	ChevronDown: () => (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
		</svg>
	),
	Edit: () => (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
			/>
		</svg>
	),
	Save: () => (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
		</svg>
	),
	Cancel: () => (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
		</svg>
	),
	Copy: () => (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
			/>
		</svg>
	),
};

export default function DocsPage() {
	const { isDark } = useTheme();
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
	const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(["(root)"]));
	const [pathCopied, setPathCopied] = useState(false);
	const markdownPreviewRef = useRef<HTMLDivElement>(null);

	const bgColor = isDark ? "bg-gray-800" : "bg-white";
	const textColor = isDark ? "text-gray-200" : "text-gray-900";
	const textSecondary = isDark ? "text-gray-400" : "text-gray-600";
	const borderColor = isDark ? "border-gray-700" : "border-gray-200";
	const hoverBg = isDark ? "hover:bg-gray-700" : "hover:bg-gray-50";

	useEffect(() => {
		loadDocs();
	}, []);

	// Handle doc path from URL navigation (e.g., #/docs/patterns/controller.md)
	const handleHashNavigation = useCallback(() => {
		if (docs.length === 0) return;

		const hash = window.location.hash;
		// Match pattern: #/docs/{path}
		const match = hash.match(/^#\/docs\/(.+)$/);

		if (match) {
			const docPath = decodeURIComponent(match[1]);
			// Normalize path
			const normalizedPath = docPath.replace(/^\.\//, "").replace(/^\//, "");

			// Find document
			const targetDoc = docs.find((doc) => {
				return (
					doc.path === normalizedPath ||
					doc.path.endsWith(`/${normalizedPath}`) ||
					doc.filename === normalizedPath
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

				// Handle task links
				if (href && /^task-\d+(.md)?$/.test(href)) {
					e.preventDefault();
					const taskId = href.replace(".md", "");

					// Navigate to tasks page with hash
					window.location.hash = `/tasks?task=${taskId}`;
					return;
				}

				// Handle document links
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
		fetch("http://localhost:6420/api/docs")
			.then((res) => res.json())
			.then((data) => {
				setDocs(data.docs || []);
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

			const response = await fetch("http://localhost:6420/api/docs", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: newDocTitle,
					description: newDocDescription,
					tags,
					folder: newDocFolder,
					content: newDocContent,
				}),
			});

			if (!response.ok) {
				throw new Error("Failed to create document");
			}

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
			// Copy as URL path for browser navigation
			const urlPath = `${window.location.origin}${window.location.pathname}#/docs/${selectedDoc.path}`;
			navigator.clipboard.writeText(urlPath).then(() => {
				setPathCopied(true);
				setTimeout(() => setPathCopied(false), 2000);
			});
		}
	};

	const handleSave = async () => {
		if (!selectedDoc) return;

		setSaving(true);
		try {
			// Update doc via CLI (we'd need an API endpoint for this)
			// For now, just simulate save
			console.log("Saving doc:", selectedDoc.filename, editedContent);

			// TODO: Add API endpoint to save doc
			// await fetch(`http://localhost:3456/api/docs/${selectedDoc.filename}`, {
			// 	method: 'PUT',
			// 	headers: { 'Content-Type': 'application/json' },
			// 	body: JSON.stringify({ content: editedContent })
			// });

			setIsEditing(false);
			// Reload docs
			loadDocs();
		} catch (error) {
			console.error("Failed to save doc:", error);
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
	}

	const buildFolderTree = (): FolderNode => {
		const root: FolderNode = {
			name: "(root)",
			path: "",
			docs: [],
			children: new Map(),
		};

		for (const doc of docs) {
			if (!doc.folder) {
				// Root level doc
				root.docs.push(doc);
			} else {
				// Nested doc
				const parts = doc.folder.split("/");
				let currentNode = root;

				for (let i = 0; i < parts.length; i++) {
					const part = parts[i];
					const pathSoFar = parts.slice(0, i + 1).join("/");

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
					className={`w-full flex items-center gap-2 px-3 py-2 ${hoverBg} ${textColor} transition-colors`}
					style={{ paddingLeft }}
				>
					{isExpanded ? <Icons.ChevronDown /> : <Icons.ChevronRight />}
					{isExpanded ? <Icons.FolderOpen /> : <Icons.Folder />}
					<span className="text-sm font-medium">{node.name}</span>
					<span className={`text-xs ${textSecondary}`}>({totalDocs})</span>
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
							// Navigate using hash to update URL
							window.location.hash = `/docs/${doc.path}`;
						}}
						className={`w-full text-left px-3 py-2 flex items-center gap-2 ${hoverBg} ${textColor} transition-colors ${
							selectedDoc?.path === doc.path ? (isDark ? "bg-gray-700" : "bg-gray-100") : ""
						}`}
						style={{ paddingLeft: `${(level + 1) * 16}px` }}
					>
						<Icons.Document />
						<div className="flex-1 min-w-0">
							<div className="text-sm font-medium truncate">{doc.metadata.title}</div>
							{doc.metadata.description && (
								<div className={`text-xs ${textSecondary} truncate`}>
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
				<div className={`text-lg ${textSecondary}`}>Loading documentation...</div>
			</div>
		);
	}

	return (
		<div className="p-6">
			{/* Header */}
			<div className="mb-6 flex items-center justify-between">
				<h1 className={`text-2xl font-bold ${textColor}`}>Documentation</h1>
				<button
					type="button"
					onClick={() => setShowCreateModal(true)}
					className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 flex items-center gap-2 transition-colors"
				>
					<Icons.Plus />
					New Document
				</button>
			</div>

			<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
				{/* Doc List */}
				<div className="lg:col-span-1">
					<div className={`${bgColor} rounded-lg border ${borderColor} overflow-hidden`}>
						<div className={`p-4 border-b ${borderColor}`}>
							<h2 className={`font-semibold ${textColor}`}>All Documents ({docs.length})</h2>
						</div>
						<div className="max-h-[600px] overflow-y-auto">
							{renderFolderNode(buildFolderTree())}
						</div>
					</div>

					{docs.length === 0 && (
						<div className={`${bgColor} rounded-lg border ${borderColor} p-8 text-center`}>
							<Icons.Document />
							<p className={`mt-2 ${textSecondary}`}>No documentation found</p>
							<p className={`text-sm ${textSecondary} mt-1`}>
								Create a doc with: <code className="font-mono">knowns doc create "Title"</code>
							</p>
						</div>
					)}
				</div>

				{/* Doc Content */}
				<div className="lg:col-span-2">
					{selectedDoc ? (
						<div className={`${bgColor} rounded-lg border ${borderColor} overflow-hidden`}>
							{/* Header */}
							<div className="p-6 border-b border-gray-700 flex items-start justify-between">
								<div className="flex-1">
									<h2 className={`text-2xl font-bold ${textColor} mb-2`}>
										{selectedDoc.metadata.title}
									</h2>
									{selectedDoc.metadata.description && (
										<p className={`${textSecondary} mb-2`}>{selectedDoc.metadata.description}</p>
									)}
									{/* Path display */}
									<button
										type="button"
										onClick={handleCopyPath}
										className={`flex items-center gap-2 px-2 py-1 rounded text-xs ${textSecondary} ${hoverBg} transition-colors group`}
										title="Click to copy URL"
									>
										<Icons.Folder />
										<span className="font-mono">/docs/{selectedDoc.path}</span>
										<span className="opacity-0 group-hover:opacity-100 transition-opacity">
											{pathCopied ? "✓" : <Icons.Copy />}
										</span>
									</button>
									<div className={`text-sm ${textSecondary} mt-2`}>
										Last updated: {new Date(selectedDoc.metadata.updatedAt).toLocaleString()}
									</div>
								</div>

								{/* Edit/Save/Cancel Buttons */}
								<div className="flex gap-2 ml-4">
									{!isEditing ? (
										<button
											type="button"
											onClick={handleEdit}
											className="px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 flex items-center gap-2 transition-colors"
										>
											<Icons.Edit />
											Edit
										</button>
									) : (
										<>
											<button
												type="button"
												onClick={handleSave}
												disabled={saving}
												className="px-3 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50 flex items-center gap-2 transition-colors"
											>
												<Icons.Save />
												{saving ? "Saving..." : "Save"}
											</button>
											<button
												type="button"
												onClick={handleCancel}
												disabled={saving}
												className={`px-3 py-2 ${isDark ? "bg-gray-700 hover:bg-gray-600" : "bg-gray-200 hover:bg-gray-300"} ${textColor} text-sm font-medium rounded-lg disabled:opacity-50 flex items-center gap-2 transition-colors`}
											>
												<Icons.Cancel />
												Cancel
											</button>
										</>
									)}
								</div>
							</div>

							{/* Content */}
							<div className="p-6">
								{isEditing ? (
									<MarkdownEditor
										markdown={editedContent}
										onChange={setEditedContent}
										placeholder="Write your documentation here..."
									/>
								) : (
									<MarkdownRenderer
										ref={markdownPreviewRef}
										markdown={selectedDoc.content || ""}
										className={textColor}
										enableGFM={true}
									/>
								)}
							</div>
						</div>
					) : (
						<div className={`${bgColor} rounded-lg border ${borderColor} p-12 text-center`}>
							<Icons.Document />
							<p className={`mt-4 ${textSecondary}`}>Select a document to view its content</p>
						</div>
					)}
				</div>
			</div>

			{/* Create Document Modal */}
			{showCreateModal && (
				<div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
					<div
						className={`${bgColor} rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto`}
					>
						<div className={`p-6 border-b ${borderColor}`}>
							<h2 className={`text-xl font-bold ${textColor}`}>Create New Document</h2>
						</div>

						<div className="p-6 space-y-4">
							{/* Title */}
							<div>
								<label className={`block text-sm font-medium ${textColor} mb-2`}>Title *</label>
								<input
									type="text"
									value={newDocTitle}
									onChange={(e) => setNewDocTitle(e.target.value)}
									placeholder="Document title"
									className={`w-full px-3 py-2 rounded-lg border ${borderColor} ${
										isDark ? "bg-gray-700 text-gray-200" : "bg-white text-gray-900"
									} focus:outline-none focus:ring-2 focus:ring-blue-500`}
								/>
							</div>

							{/* Description */}
							<div>
								<label className={`block text-sm font-medium ${textColor} mb-2`}>Description</label>
								<input
									type="text"
									value={newDocDescription}
									onChange={(e) => setNewDocDescription(e.target.value)}
									placeholder="Brief description"
									className={`w-full px-3 py-2 rounded-lg border ${borderColor} ${
										isDark ? "bg-gray-700 text-gray-200" : "bg-white text-gray-900"
									} focus:outline-none focus:ring-2 focus:ring-blue-500`}
								/>
							</div>

							{/* Folder */}
							<div>
								<label className={`block text-sm font-medium ${textColor} mb-2`}>
									Folder (optional)
								</label>
								<input
									type="text"
									value={newDocFolder}
									onChange={(e) => setNewDocFolder(e.target.value)}
									placeholder="api/auth, guides, etc. (leave empty for root)"
									className={`w-full px-3 py-2 rounded-lg border ${borderColor} ${
										isDark ? "bg-gray-700 text-gray-200" : "bg-white text-gray-900"
									} focus:outline-none focus:ring-2 focus:ring-blue-500`}
								/>
							</div>

							{/* Tags */}
							<div>
								<label className={`block text-sm font-medium ${textColor} mb-2`}>
									Tags (comma-separated)
								</label>
								<input
									type="text"
									value={newDocTags}
									onChange={(e) => setNewDocTags(e.target.value)}
									placeholder="guide, tutorial, api"
									className={`w-full px-3 py-2 rounded-lg border ${borderColor} ${
										isDark ? "bg-gray-700 text-gray-200" : "bg-white text-gray-900"
									} focus:outline-none focus:ring-2 focus:ring-blue-500`}
								/>
							</div>

							{/* Content */}
							<div>
								<label className={`block text-sm font-medium ${textColor} mb-2`}>Content</label>
								<MarkdownEditor
									markdown={newDocContent}
									onChange={setNewDocContent}
									placeholder="Write your documentation here..."
								/>
							</div>
						</div>

						<div className={`p-6 border-t ${borderColor} flex justify-end gap-3`}>
							<button
								type="button"
								onClick={() => {
									setShowCreateModal(false);
									setNewDocTitle("");
									setNewDocDescription("");
									setNewDocTags("");
									setNewDocFolder("");
									setNewDocContent("");
								}}
								disabled={creating}
								className={`px-4 py-2 ${
									isDark ? "bg-gray-700 hover:bg-gray-600" : "bg-gray-200 hover:bg-gray-300"
								} ${textColor} text-sm font-medium rounded-lg disabled:opacity-50 transition-colors`}
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={handleCreateDoc}
								disabled={creating || !newDocTitle.trim()}
								className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
							>
								{creating ? "Creating..." : "Create Document"}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
