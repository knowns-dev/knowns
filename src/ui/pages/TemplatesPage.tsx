import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Plus,
	FileCode,
	Play,
	Eye,
	Check,
	X,
	ChevronRight,
	ChevronDown,
	Copy,
	FileText,
	AlertCircle,
	HelpCircle,
	Sparkles,
	FolderOpen,
	Folder,
	Loader2,
} from "lucide-react";
import { ScrollArea } from "../components/ui/scroll-area";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { TreeView, type TreeDataItem } from "../components/ui/tree-view";
import {
	templateApi,
	type TemplateListItem,
	type TemplateDetail,
	type TemplateRunResult,
} from "../api/client";
import { useSSEEvent } from "../contexts/SSEContext";

// Simple case conversion helpers for preview
const toPascalCase = (str: string) =>
	str
		.replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""))
		.replace(/^(.)/, (c) => c.toUpperCase());

const toKebabCase = (str: string) =>
	str
		.replace(/([a-z])([A-Z])/g, "$1-$2")
		.replace(/[\s_]+/g, "-")
		.toLowerCase();

const toCamelCase = (str: string) =>
	str
		.replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""))
		.replace(/^(.)/, (c) => c.toLowerCase());

// Build TreeDataItem[] from templates
function buildTemplateTreeData(
	templates: TemplateListItem[],
	onSelect: (name: string) => void
): TreeDataItem[] {
	interface TempNode {
		id: string;
		name: string;
		isTemplate: boolean;
		template?: TemplateListItem;
		children: Map<string, TempNode>;
	}

	const root: Map<string, TempNode> = new Map();

	for (const template of templates) {
		const parts = template.name.split("/");
		let currentMap = root;

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isTemplate = i === parts.length - 1;
			const currentPath = parts.slice(0, i + 1).join("/");

			if (!currentMap.has(part)) {
				currentMap.set(part, {
					id: currentPath,
					name: part,
					isTemplate,
					template: isTemplate ? template : undefined,
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
				// Folders first, then templates
				if (a.isTemplate !== b.isTemplate) return a.isTemplate ? 1 : -1;
				return a.name.localeCompare(b.name);
			})
			.map((node): TreeDataItem => ({
				id: node.id,
				name: node.name,
				icon: node.isTemplate ? FileCode : Folder,
				openIcon: node.isTemplate ? FileCode : FolderOpen,
				children: node.children.size > 0 ? convertToTreeData(node.children) : undefined,
				onClick: node.isTemplate ? () => onSelect(node.id) : undefined,
			}));
	};

	return convertToTreeData(root);
}

export default function TemplatesPage() {
	const [templates, setTemplates] = useState<TemplateListItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [selectedTemplate, setSelectedTemplate] = useState<TemplateDetail | null>(null);
	const [selectedName, setSelectedName] = useState<string | null>(null);
	const [loadingDetail, setLoadingDetail] = useState(false);

	// Run template state
	const [variables, setVariables] = useState<Record<string, string>>({});
	const [dryRun, setDryRun] = useState(true);
	const [running, setRunning] = useState(false);
	const [runResult, setRunResult] = useState<TemplateRunResult | null>(null);
	const [runError, setRunError] = useState<string | null>(null);

	// Create template state
	const [showCreateModal, setShowCreateModal] = useState(false);
	const [newTemplateName, setNewTemplateName] = useState("");
	const [newTemplateDescription, setNewTemplateDescription] = useState("");
	const [newTemplateDoc, setNewTemplateDoc] = useState("");
	const [creating, setCreating] = useState(false);

	const [pathCopied, setPathCopied] = useState(false);

	// File preview state
	const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
	const [fileContents, setFileContents] = useState<Record<string, string>>({});
	const [loadingPreviews, setLoadingPreviews] = useState<Set<string>>(new Set());

	// Check if all required variables are filled
	const requiredVarsFilled = useMemo(() => {
		if (!selectedTemplate) return false;
		return selectedTemplate.prompts
			.filter((p) => p.required)
			.every((p) => variables[p.name]?.trim());
	}, [selectedTemplate, variables]);

	// Helper to substitute variables in a path
	const substituteVars = useCallback((path: string) => {
		let result = path;
		for (const [key, value] of Object.entries(variables)) {
			if (value) {
				result = result
					.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g"), value)
					.replace(new RegExp(`\\{\\{\\s*pascalCase\\s+${key}\\s*\\}\\}`, "g"), toPascalCase(value))
					.replace(new RegExp(`\\{\\{\\s*camelCase\\s+${key}\\s*\\}\\}`, "g"), toCamelCase(value))
					.replace(new RegExp(`\\{\\{\\s*kebabCase\\s+${key}\\s*\\}\\}`, "g"), toKebabCase(value));
			}
		}
		return result;
	}, [variables]);

	// Preview file paths with variable substitution
	const previewFilePaths = useMemo(() => {
		if (!selectedTemplate) return [];
		return selectedTemplate.files.map((file) => {
			if (file.type === "add") {
				const preview = substituteVars(file.destination);
				return {
					type: "add" as const,
					destination: file.destination,
					preview,
					condition: file.condition,
					template: file.template,
				};
			}
			// addMany
			const preview = substituteVars(file.destination);
			return {
				type: "addMany" as const,
				destination: file.destination,
				preview,
				condition: file.condition,
				source: file.source,
				globPattern: file.globPattern,
			};
		});
	}, [selectedTemplate, substituteVars]);

	// Load templates
	const loadTemplates = useCallback(async () => {
		try {
			const data = await templateApi.list();
			setTemplates(data.templates);
		} catch (err) {
			console.error("Failed to load templates:", err);
		} finally {
			setLoading(false);
		}
	}, []);

	// Initial load
	useEffect(() => {
		loadTemplates();
	}, [loadTemplates]);

	// Subscribe to SSE for real-time updates
	useSSEEvent("templates:created", () => {
		loadTemplates();
	});

	useSSEEvent("templates:run", () => {
		// Could refresh file explorer or show notification
	});

	// Handle template selection from URL
	const handleHashNavigation = useCallback(() => {
		if (templates.length === 0) return;

		const hash = window.location.hash;
		const match = hash.match(/^#\/templates\/(.+)$/);

		if (match) {
			const templateName = decodeURIComponent(match[1]);
			if (templateName !== selectedName) {
				loadTemplateDetail(templateName);
			}
		}
	}, [templates, selectedName]);

	useEffect(() => {
		handleHashNavigation();
	}, [handleHashNavigation]);

	useEffect(() => {
		window.addEventListener("hashchange", handleHashNavigation);
		return () => window.removeEventListener("hashchange", handleHashNavigation);
	}, [handleHashNavigation]);

	// Load template detail
	const loadTemplateDetail = async (name: string) => {
		setLoadingDetail(true);
		setRunResult(null);
		setRunError(null);
		setSelectedName(name);

		try {
			const data = await templateApi.get(name);
			setSelectedTemplate(data.template);

			// Initialize variables with defaults
			const initialVars: Record<string, string> = {};
			for (const prompt of data.template.prompts) {
				if (prompt.default !== undefined) {
					initialVars[prompt.name] = String(prompt.default);
				} else if (prompt.type === "confirm") {
					initialVars[prompt.name] = "false";
				} else {
					initialVars[prompt.name] = "";
				}
			}
			setVariables(initialVars);
		} catch (err) {
			console.error("Failed to load template:", err);
			setSelectedTemplate(null);
		} finally {
			setLoadingDetail(false);
		}
	};

	// Select template
	const handleSelectTemplate = (name: string) => {
		// Encode each path segment separately to preserve `/` in URL
		const encodedName = name.split('/').map(encodeURIComponent).join('/');
		window.location.hash = `/templates/${encodedName}`;
	};

	// Copy reference
	const handleCopyRef = () => {
		if (selectedTemplate) {
			const ref = `@template/${selectedTemplate.name}`;
			navigator.clipboard.writeText(ref).then(() => {
				setPathCopied(true);
				setTimeout(() => setPathCopied(false), 2000);
			});
		}
	};

	// Run template
	const handleRunTemplate = async () => {
		if (!selectedTemplate) return;

		setRunning(true);
		setRunResult(null);
		setRunError(null);

		try {
			const result = await templateApi.run(selectedTemplate.name, variables, dryRun);
			setRunResult(result);
		} catch (err) {
			setRunError(err instanceof Error ? err.message : String(err));
		} finally {
			setRunning(false);
		}
	};

	// Create template
	const handleCreateTemplate = async () => {
		if (!newTemplateName.trim()) {
			return;
		}

		setCreating(true);
		try {
			await templateApi.create({
				name: newTemplateName,
				description: newTemplateDescription || undefined,
				doc: newTemplateDoc || undefined,
			});

			// Reset form
			setNewTemplateName("");
			setNewTemplateDescription("");
			setNewTemplateDoc("");
			setShowCreateModal(false);

			// Reload templates
			loadTemplates();
		} catch (err) {
			console.error("Failed to create template:", err);
			alert(err instanceof Error ? err.message : "Failed to create template");
		} finally {
			setCreating(false);
		}
	};

	// Navigate to linked doc
	const handleDocClick = () => {
		if (selectedTemplate?.doc) {
			window.location.hash = `/docs/${selectedTemplate.doc}.md`;
		}
	};

	// Toggle file preview expansion
	const toggleFilePreview = async (templateFile: string) => {
		const newExpanded = new Set(expandedFiles);

		if (expandedFiles.has(templateFile)) {
			// Collapse
			newExpanded.delete(templateFile);
			setExpandedFiles(newExpanded);
		} else {
			// Expand and load content if not cached
			newExpanded.add(templateFile);
			setExpandedFiles(newExpanded);

			if (!fileContents[templateFile] && selectedTemplate) {
				setLoadingPreviews((prev) => new Set(prev).add(templateFile));
				try {
					const result = await templateApi.previewFile(
						selectedTemplate.name,
						templateFile,
						variables
					);
					setFileContents((prev) => ({
						...prev,
						[templateFile]: result.content,
					}));
				} catch (err) {
					console.error("Failed to load preview:", err);
					setFileContents((prev) => ({
						...prev,
						[templateFile]: `Error loading preview: ${err instanceof Error ? err.message : String(err)}`,
					}));
				} finally {
					setLoadingPreviews((prev) => {
						const next = new Set(prev);
						next.delete(templateFile);
						return next;
					});
				}
			}
		}
	};

	// Clear file previews when variables change
	useEffect(() => {
		setFileContents({});
	}, [variables]);

	if (loading) {
		return (
			<div className="p-6 flex items-center justify-center h-64">
				<div className="text-lg text-muted-foreground">Loading templates...</div>
			</div>
		);
	}

	return (
		<div className="p-6 h-full flex flex-col overflow-hidden">
			{/* Header */}
			<div className="mb-6 flex items-center justify-between">
				<div>
					<h1 className="text-2xl font-bold">Code Templates</h1>
					<p className="text-sm text-muted-foreground mt-1">
						Generate boilerplate code from reusable templates
					</p>
				</div>
				<Button
					onClick={() => setShowCreateModal(true)}
					className="bg-green-700 hover:bg-green-800 text-white"
				>
					<Plus className="w-4 h-4 mr-2" />
					New Template
				</Button>
			</div>

			<div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 min-h-0 overflow-hidden">
				{/* Template List */}
				<div className="lg:col-span-1 flex flex-col min-h-0 overflow-hidden">
					<div className="bg-card rounded-lg border overflow-hidden flex flex-col flex-1 min-h-0">
						<ScrollArea className="flex-1">
							{(() => {
								// Separate local and imported templates
								const localTemplates = templates.filter((t) => !t.isImported);
								const importedTemplates = templates.filter((t) => t.isImported);

								// Group imported templates by source
								const importedBySource = importedTemplates.reduce(
									(acc, t) => {
										const source = t.source || "unknown";
										if (!acc[source]) acc[source] = [];
										acc[source].push(t);
										return acc;
									},
									{} as Record<string, typeof importedTemplates>,
								);

								const treeData: TreeDataItem[] = [];

								// Local templates
								if (localTemplates.length > 0) {
									treeData.push({
										id: "__local__",
										name: `Local (${localTemplates.length})`,
										icon: Folder,
										openIcon: FolderOpen,
										children: buildTemplateTreeData(localTemplates, handleSelectTemplate),
									});
								}

								// Imported templates grouped by source
								const importSources = Object.keys(importedBySource);
								if (importSources.length > 0) {
									const importChildren: TreeDataItem[] = importSources.map((source) => {
										// Strip source prefix from template names for display
										// but keep mapping to original name for selection
										// e.g., "knowns/knowns-command" displays as "knowns-command"
										const originalNames = new Map<string, string>();
										const templatesWithStrippedNames = importedBySource[source].map((t) => {
											const strippedName = t.name.startsWith(`${source}/`)
												? t.name.slice(source.length + 1)
												: t.name;
											originalNames.set(strippedName, t.name);
											return { ...t, name: strippedName };
										});
										// Wrapper to map stripped name back to original
										const selectWithOriginalName = (name: string) => {
											const original = originalNames.get(name) || name;
											handleSelectTemplate(original);
										};
										return {
											id: `__import_${source}__`,
											name: `${source} (${importedBySource[source].length})`,
											icon: Folder,
											openIcon: FolderOpen,
											children: buildTemplateTreeData(templatesWithStrippedNames, selectWithOriginalName),
										};
									});

									treeData.push({
										id: "__imports__",
										name: `Imports (${importedTemplates.length})`,
										icon: Folder,
										openIcon: FolderOpen,
										children: importChildren,
									});
								}

								if (treeData.length === 0) {
									return (
										<div className="p-8 text-center">
											<FileCode className="w-12 h-12 mx-auto text-muted-foreground" />
											<p className="mt-2 font-medium">No templates yet</p>
											<p className="text-sm text-muted-foreground mt-1">
												Templates help you generate consistent code quickly
											</p>
											<Button
												onClick={() => setShowCreateModal(true)}
												className="mt-4"
												variant="outline"
											>
												<Plus className="w-4 h-4 mr-2" />
												Create your first template
											</Button>
										</div>
									);
								}

								return (
									<TreeView
										data={treeData}
										defaultNodeIcon={Folder}
										defaultLeafIcon={FileCode}
										initialSelectedItemId={selectedName || undefined}
									/>
								);
							})()}
						</ScrollArea>
					</div>
				</div>

				{/* Template Detail & Runner */}
				<div className="lg:col-span-2 flex flex-col min-h-0 overflow-hidden">
					{loadingDetail ? (
						<div className="bg-card rounded-lg border p-12 text-center">
							<div className="text-muted-foreground">Loading template...</div>
						</div>
					) : selectedTemplate ? (
						<div className="bg-card rounded-lg border overflow-hidden flex flex-col flex-1 min-h-0">
							{/* Header */}
							<div className="p-6 border-b shrink-0 bg-gradient-to-r from-blue-50 to-transparent dark:from-blue-950/20">
								<div className="flex items-start justify-between gap-4">
									<div className="flex-1">
										<div className="flex items-center gap-2 mb-1">
											<Sparkles className="w-5 h-5 text-blue-500" />
											<h2 className="text-xl font-bold">{selectedTemplate.name}</h2>
										</div>
										{selectedTemplate.description && (
											<p className="text-muted-foreground">
												{selectedTemplate.description}
											</p>
										)}
										<div className="flex items-center gap-3 mt-3">
											{/* Reference button */}
											<button
												type="button"
												onClick={handleCopyRef}
												className="flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors"
												title="Click to copy reference"
											>
												<Copy className="w-3 h-3" />
												<span className="font-mono">@template/{selectedTemplate.name}</span>
												{pathCopied && <Check className="w-3 h-3" />}
											</button>
											{/* Linked doc button */}
											{selectedTemplate.doc && (
												<button
													type="button"
													onClick={handleDocClick}
													className="flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors"
												>
													<FileText className="w-3 h-3" />
													<span>View Documentation</span>
												</button>
											)}
										</div>
									</div>
								</div>
							</div>

							<ScrollArea className="flex-1">
								<div className="p-6 space-y-6">
									{/* Step 1: Fill Variables */}
									<div>
										<div className="flex items-center gap-2 mb-4">
											<div className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 text-sm font-bold">
												1
											</div>
											<h3 className="font-semibold">Fill in the values</h3>
											{selectedTemplate.prompts.length === 0 && (
												<span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
													No input needed
												</span>
											)}
										</div>

										{selectedTemplate.prompts.length > 0 && (
											<div className="space-y-4 pl-8">
												{selectedTemplate.prompts.map((prompt) => (
													<div key={prompt.name} className="space-y-2">
														<Label className="flex items-center gap-2">
															<span className="font-medium">{prompt.name}</span>
															{prompt.required ? (
																<span className="text-xs bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-1.5 py-0.5 rounded">
																	Required
																</span>
															) : (
																<span className="text-xs bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 px-1.5 py-0.5 rounded">
																	Optional
																</span>
															)}
														</Label>
														{prompt.message && (
															<p className="text-sm text-muted-foreground -mt-1">
																{prompt.message}
															</p>
														)}
														{prompt.type === "confirm" ? (
															<div className="flex items-center gap-3 p-3 rounded-lg border bg-muted/30">
																<Switch
																	checked={variables[prompt.name] === "true"}
																	onCheckedChange={(checked) =>
																		setVariables((prev) => ({
																			...prev,
																			[prompt.name]: checked ? "true" : "false",
																		}))
																	}
																/>
																<span className="text-sm">
																	{variables[prompt.name] === "true" ? "Yes" : "No"}
																</span>
															</div>
														) : prompt.choices ? (
															<select
																value={variables[prompt.name] || ""}
																onChange={(e) =>
																	setVariables((prev) => ({
																		...prev,
																		[prompt.name]: e.target.value,
																	}))
																}
																className="w-full px-3 py-2 rounded-lg border bg-background"
															>
																<option value="">-- Select an option --</option>
																{prompt.choices.map((choice) => (
																	<option key={choice.value} value={choice.value}>
																		{choice.label}
																	</option>
																))}
															</select>
														) : (
															<Input
																type="text"
																value={variables[prompt.name] || ""}
																onChange={(e) =>
																	setVariables((prev) => ({
																		...prev,
																		[prompt.name]: e.target.value,
																	}))
																}
																placeholder={
																	prompt.default !== undefined
																		? `Default: ${prompt.default}`
																		: `Enter ${prompt.name}...`
																}
																className={
																	prompt.required && !variables[prompt.name]?.trim()
																		? "border-orange-300 dark:border-orange-700"
																		: ""
																}
															/>
														)}
													</div>
												))}
											</div>
										)}
									</div>

									{/* Step 2: Preview Files */}
									<div>
										<div className="flex items-center gap-2 mb-4">
											<div className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 text-sm font-bold">
												2
											</div>
											<h3 className="font-semibold">Files that will be created</h3>
										</div>

										<div className="pl-8">
											{/* Destination directory info */}
											<div className="mb-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
												<div className="flex items-center gap-2 text-amber-800 dark:text-amber-300">
													<FolderOpen className="w-4 h-4" />
													<span className="text-sm font-medium">Output directory:</span>
													<code className="text-sm font-mono bg-amber-100 dark:bg-amber-900/50 px-2 py-0.5 rounded">
														{selectedTemplate.destination === "./"
															? "Project root"
															: selectedTemplate.destination}
													</code>
												</div>
											</div>
										</div>

										<div className="pl-8">
											<div className="rounded-lg border bg-muted/30 overflow-hidden">
												{previewFilePaths.map((file, idx) => {
													const isExpandable = file.type === "add";
													const templateFile = file.type === "add" ? file.template : null;
													const isExpanded = templateFile ? expandedFiles.has(templateFile) : false;
													const isLoading = templateFile ? loadingPreviews.has(templateFile) : false;
													const content = templateFile ? fileContents[templateFile] : null;

													return (
														<div key={idx} className="border-b last:border-b-0">
															<button
																type="button"
																onClick={() => isExpandable && templateFile && toggleFilePreview(templateFile)}
																className={`w-full flex items-center gap-3 px-4 py-3 text-left ${
																	isExpandable ? "hover:bg-accent/50 cursor-pointer" : ""
																}`}
																disabled={!isExpandable}
															>
																{isExpandable ? (
																	isExpanded ? (
																		<ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
																	) : (
																		<ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
																	)
																) : null}
																{file.type === "addMany" ? (
																	<FolderOpen className="w-4 h-4 text-yellow-600 dark:text-yellow-500 shrink-0" />
																) : (
																	<FileCode className="w-4 h-4 text-blue-500 shrink-0" />
																)}
																<div className="flex-1 min-w-0">
																	<code className="text-sm font-mono block truncate">
																		{file.type === "addMany"
																			? `${file.preview}/${file.globPattern || "**/*.hbs"}`
																			: file.preview}
																	</code>
																	{file.preview !== file.destination && (
																		<span className="text-xs text-muted-foreground">
																			Pattern: {file.destination}
																		</span>
																	)}
																	{file.type === "addMany" && (
																		<span className="text-xs text-blue-600 dark:text-blue-400 ml-2">
																			(multiple files)
																		</span>
																	)}
																</div>
																{file.condition && (
																	<span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded shrink-0">
																		Conditional
																	</span>
																)}
																{isExpandable && (
																	<span className="text-xs text-muted-foreground shrink-0">
																		{isExpanded ? "Hide" : "Preview"}
																	</span>
																)}
															</button>

															{/* Expanded content preview */}
															{isExpanded && (
																<div className="border-t bg-gray-950 dark:bg-gray-900">
																	{isLoading ? (
																		<div className="p-4 flex items-center justify-center text-muted-foreground">
																			<Loader2 className="w-4 h-4 animate-spin mr-2" />
																			Loading preview...
																		</div>
																	) : (
																		<pre className="p-4 text-xs font-mono text-gray-300 overflow-x-auto max-h-80 overflow-y-auto">
																			<code>{content || "No content"}</code>
																		</pre>
																	)}
																</div>
															)}
														</div>
													);
												})}
												{previewFilePaths.length === 0 && (
													<div className="px-4 py-8 text-center text-muted-foreground">
														<HelpCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
														<p>No files configured in this template</p>
													</div>
												)}
											</div>
										</div>
									</div>

									{/* Step 3: Generate */}
									<div>
										<div className="flex items-center gap-2 mb-4">
											<div className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 text-sm font-bold">
												3
											</div>
											<h3 className="font-semibold">Generate files</h3>
										</div>

										<div className="pl-8">
											<div className="flex flex-wrap items-center gap-4 p-4 rounded-lg border bg-muted/30">
												<div className="flex items-center gap-2">
													<Switch
														id="dry-run"
														checked={dryRun}
														onCheckedChange={setDryRun}
													/>
													<Label htmlFor="dry-run" className="text-sm cursor-pointer">
														Preview mode
													</Label>
													<span className="text-xs text-muted-foreground">
														(no files created)
													</span>
												</div>

												<div className="flex-1" />

												<Button
													onClick={handleRunTemplate}
													disabled={running || !requiredVarsFilled}
													size="lg"
													className={
														dryRun
															? ""
															: "bg-green-600 hover:bg-green-700 text-white"
													}
												>
													{running ? (
														<>
															<span className="animate-spin mr-2">⏳</span>
															Running...
														</>
													) : dryRun ? (
														<>
															<Eye className="w-4 h-4 mr-2" />
															Preview Result
														</>
													) : (
														<>
															<Play className="w-4 h-4 mr-2" />
															Generate Files
														</>
													)}
												</Button>
											</div>

											{!requiredVarsFilled && selectedTemplate.prompts.some((p) => p.required) && (
												<p className="text-sm text-orange-600 dark:text-orange-400 mt-2 flex items-center gap-1">
													<AlertCircle className="w-4 h-4" />
													Please fill in all required fields above
												</p>
											)}
										</div>
									</div>

									{/* Run Result */}
									{runError && (
										<div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg p-4">
											<div className="flex items-start gap-2 text-red-600 dark:text-red-400">
												<AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
												<div>
													<div className="font-medium">Error</div>
													<div className="text-sm">{runError}</div>
												</div>
											</div>
										</div>
									)}

									{runResult && (
										<div
											className={`border rounded-lg p-4 ${
												runResult.dryRun
													? "bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800"
													: "bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800"
											}`}
										>
											<div className="flex items-start gap-3">
												{runResult.dryRun ? (
													<Eye className="w-6 h-6 text-blue-600 dark:text-blue-400 shrink-0" />
												) : (
													<Check className="w-6 h-6 text-green-600 dark:text-green-400 shrink-0" />
												)}
												<div className="flex-1">
													<div className="font-semibold text-lg">
														{runResult.dryRun ? "Preview Complete" : "Files Generated!"}
													</div>
													<div className="text-sm text-muted-foreground mb-4">
														{runResult.dryRun
															? "Turn off preview mode and click 'Generate Files' to create these files."
															: runResult.message}
													</div>
													<div className="space-y-2">
														{runResult.files.map((file, idx) => (
															<div
																key={idx}
																className="flex items-center gap-2 text-sm"
															>
																{file.skipped ? (
																	<X className="w-4 h-4 text-muted-foreground shrink-0" />
																) : (
																	<Check className="w-4 h-4 text-green-600 shrink-0" />
																)}
																<code
																	className={`font-mono ${
																		file.skipped ? "text-muted-foreground" : ""
																	}`}
																>
																	{file.path}
																</code>
																{file.skipped && file.skipReason && (
																	<span className="text-xs text-muted-foreground">
																		({file.skipReason})
																	</span>
																)}
															</div>
														))}
													</div>
													{runResult.dryRun && runResult.files.length > 0 && (
														<Button
															onClick={() => {
																setDryRun(false);
																handleRunTemplate();
															}}
															className="mt-4 bg-green-600 hover:bg-green-700 text-white"
														>
															<Play className="w-4 h-4 mr-2" />
															Generate These Files Now
														</Button>
													)}
												</div>
											</div>
										</div>
									)}
								</div>
							</ScrollArea>
						</div>
					) : (
						<div className="bg-card rounded-lg border p-12 text-center">
							<FileCode className="w-16 h-16 mx-auto text-muted-foreground/50" />
							<h3 className="mt-4 text-lg font-medium">Select a template</h3>
							<p className="mt-2 text-muted-foreground max-w-md mx-auto">
								Choose a template from the list to generate code. Templates help you create consistent files quickly.
							</p>
						</div>
					)}
				</div>
			</div>

			{/* Create Template Modal */}
			{showCreateModal && (
				<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
					<div className="bg-card rounded-lg shadow-xl max-w-md w-full">
						<div className="p-6 border-b">
							<h2 className="text-xl font-bold">Create New Template</h2>
							<p className="text-sm text-muted-foreground mt-1">
								Templates are stored in .knowns/templates/
							</p>
						</div>

						<div className="p-6 space-y-4">
							<div>
								<Label className="mb-2 block">
									Template Name <span className="text-red-500">*</span>
								</Label>
								<Input
									type="text"
									value={newTemplateName}
									onChange={(e) => setNewTemplateName(e.target.value)}
									placeholder="e.g., react-component, api-endpoint"
								/>
								<p className="text-xs text-muted-foreground mt-1">
									Use lowercase with hyphens (kebab-case)
								</p>
							</div>

							<div>
								<Label className="mb-2 block">Description</Label>
								<Input
									type="text"
									value={newTemplateDescription}
									onChange={(e) => setNewTemplateDescription(e.target.value)}
									placeholder="e.g., Generate a new React component with tests"
								/>
							</div>

							<div>
								<Label className="mb-2 block">Link to Documentation</Label>
								<Input
									type="text"
									value={newTemplateDoc}
									onChange={(e) => setNewTemplateDoc(e.target.value)}
									placeholder="e.g., patterns/react-component"
								/>
								<p className="text-xs text-muted-foreground mt-1">
									Optional: Link to a doc that explains when/how to use this template
								</p>
							</div>
						</div>

						<div className="p-6 border-t flex justify-end gap-3">
							<Button
								variant="secondary"
								onClick={() => {
									setShowCreateModal(false);
									setNewTemplateName("");
									setNewTemplateDescription("");
									setNewTemplateDoc("");
								}}
								disabled={creating}
							>
								Cancel
							</Button>
							<Button
								onClick={handleCreateTemplate}
								disabled={creating || !newTemplateName.trim()}
								className="bg-green-700 hover:bg-green-800 text-white"
							>
								{creating ? "Creating..." : "Create Template"}
							</Button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
