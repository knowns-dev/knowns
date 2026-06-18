import { useEffect, useState, useRef, useCallback } from "react";
import {
	Settings,
	Check,
	Plus,
	Trash2,
	Columns3,
	User,
	Clock,
	Tag,
	Palette,
	Eye,
	Terminal,
	Bot,
	Loader2,
	AlertCircle,
	CheckCircle2,
	Download,
	Package,
	ChevronRight,
	RefreshCw,
	X,
	Monitor,
	Power,
	PowerOff,
	Activity,
	Search,
	Code2,
	Wrench,
	Globe,
	Shield,
	Copy,
	type LucideIcon,
} from "lucide-react";
import { ScrollArea } from "../components/ui/ScrollArea";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Separator } from "../components/ui/separator";
import { Label } from "../components/ui/label";
import { Badge } from "../components/ui/badge";
import { useConfig, type Config } from "../contexts/ConfigContext";
import { useAuth } from "../contexts/AuthContext";
import { useOpenCode } from "../contexts/OpenCodeContext";
import { useOpenCodeModelManager } from "../hooks/useOpencodeModelManager";
import { OpenCodeModelManager } from "../components/organisms/OpenCodeModelManager";
import { toast } from "../components/ui/sonner";
import { importApi, saveUserPreferences, getRuntimeServices, getEmbeddingModels, testEmbeddingModel, tunnelApi, lspApi, type EmbeddingModelInfo, type EmbeddingModelsResponse, type EmbeddingModelTestResult, type Import, type ImportDetail, type ImportResult, type RuntimeService, type LSPLanguageInfo } from "../api/client";

const DEFAULT_STATUSES = ["todo", "in-progress", "in-review", "done", "blocked", "on-hold", "urgent"];
const COLOR_OPTIONS = ["gray", "blue", "green", "yellow", "red", "purple", "orange", "pink", "cyan", "indigo"];
const CSHARP_BACKENDS = ["auto", "roslyn-ls", "csharp-ls", "omnisharp"];

type LSPLogKind = "runtime" | "trace";

interface LSPConfigDraft {
	backend?: string;
	projectPath?: string;
	version?: string;
	binary?: string;
}

interface LSPLogPanelState {
	kind: LSPLogKind;
	content: string;
	path?: string;
	loading?: boolean;
}

function displayValue(value?: string) {
	return value && value.trim() ? value : "-";
}

function statusVariant(status?: string): "default" | "secondary" | "destructive" | "outline" {
	switch (status) {
		case "running":
		case "ready":
		case "installed":
			return "default";
		case "crashed":
		case "error":
			return "destructive";
		case "starting":
		case "indexing":
			return "secondary";
		default:
			return "outline";
	}
}

// ── Category definitions ──────────────────────────────────────────

type Category = "general" | "board" | "search" | "code" | "ai" | "imports" | "runtime" | "tunnel" | "security" | "advanced";

interface CategoryDef {
	id: Category;
	label: string;
	icon: LucideIcon;
	description: string;
}

const ALL_CATEGORIES: CategoryDef[] = [
	{ id: "general", label: "General", icon: Settings, description: "Project name, defaults, and preferences" },
	{ id: "board", label: "Board", icon: Columns3, description: "Kanban statuses, colors, and visible columns" },
	{ id: "search", label: "Search", icon: Search, description: "Semantic search configuration" },
	{ id: "code", label: "Code", icon: Code2, description: "LSP servers and code intelligence" },
	{ id: "ai", label: "AI", icon: Bot, description: "OpenCode connection used by Chat UI" },
	{ id: "imports", label: "Imports", icon: Download, description: "Imported templates and docs" },
	{ id: "runtime", label: "Runtime", icon: Monitor, description: "Runtime services and sub-processes" },
	{ id: "tunnel", label: "Tunnel", icon: Globe, description: "Cloudflare Tunnel for remote access" },
	{ id: "security", label: "Security", icon: Shield, description: "Password protection" },
	{ id: "advanced", label: "Advanced", icon: Wrench, description: "Git tracking, server, platforms, and JSON" },
];

// ── Auto-save hook ────────────────────────────────────────────────

function useAutoSave(config: Config, updateConfig: (c: Partial<Config>) => Promise<void>, initialized: boolean) {
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const prevRef = useRef<string>("");

	const save = useCallback(
		(cfg: Config) => {
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(async () => {
				const serialized = JSON.stringify(cfg);
				if (serialized === prevRef.current) return;
				prevRef.current = serialized;
				try {
					await updateConfig(cfg);
					toast.success("Saved", { duration: 1500, position: "bottom-right" });
				} catch {
					toast.error("Failed to save settings", { position: "bottom-right" });
				}
			}, 600);
		},
		[updateConfig],
	);

	useEffect(() => {
		if (initialized) {
			prevRef.current = JSON.stringify(config);
		}
	}, [initialized]); // eslint-disable-line react-hooks/exhaustive-deps

	return save;
}

// ── Section header component ──────────────────────────────────────

function SectionHeader({ icon: Icon, title, description }: { icon: LucideIcon; title: string; description: string }) {
	return (
		<div className="mb-5">
			<div className="flex items-center gap-2.5 mb-1">
				<Icon className="w-[18px] h-[18px] text-muted-foreground" />
				<h3 className="text-sm font-semibold">{title}</h3>
			</div>
			<p className="text-xs text-muted-foreground ml-[30px]">{description}</p>
		</div>
	);
}

// ── Field row component ───────────────────────────────────────────

function FieldRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
	return (
		<div className="flex items-start gap-4 py-3">
			<div className="w-44 shrink-0 pt-2">
				<div className="text-sm font-medium">{label}</div>
				{hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
			</div>
			<div className="flex-1 min-w-0">{children}</div>
		</div>
	);
}

// ── Main component ────────────────────────────────────────────────

export default function ConfigPage() {
	const { config: globalConfig, loading, updateConfig, chatUIEnabled } = useConfig();
	const [config, setConfig] = useState<Config>({});
	const [activeCategory, setActiveCategory] = useState<Category>("general");
	const [initialized, setInitialized] = useState(false);
	const [saving, setSaving] = useState(false);
	const [jsonText, setJsonText] = useState("");
	const [jsonError, setJsonError] = useState<string | null>(null);
	const [newStatus, setNewStatus] = useState("");
	const { status: openCodeStatus, statusLoading: openCodeStatusLoading, providerResponse, providersLoading, lastLoadedAt, refreshAll } =
		useOpenCode();

	// Imports state
	const [imports, setImports] = useState<Import[]>([]);
	const [importsLoading, setImportsLoading] = useState(true);
	const [selectedImport, setSelectedImport] = useState<ImportDetail | null>(null);
	const [showAddModal, setShowAddModal] = useState(false);
	const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
	const [syncingImport, setSyncingImport] = useState<string | null>(null);
	const [removingImport, setRemovingImport] = useState<string | null>(null);
	const [removeDeleteFiles, setRemoveDeleteFiles] = useState(false);

	// Add import form state
	const [addSource, setAddSource] = useState("");
	const [addName, setAddName] = useState("");
	const [addType, setAddType] = useState("");
	const [addRef, setAddRef] = useState("");
	const [addLink, setAddLink] = useState(false);
	const [addDryRun, setAddDryRun] = useState(true);
	const [adding, setAdding] = useState(false);
	const [addResult, setAddResult] = useState<ImportResult | null>(null);
	const [addError, setAddError] = useState<string | null>(null);

	// Load imports
	const loadImports = useCallback(async () => {
		try {
			const data = await importApi.list();
			setImports(data.imports);
		} catch (err) {
			console.error("Failed to load imports:", err);
		} finally {
			setImportsLoading(false);
		}
	}, []);

	// Load import detail
	const loadImportDetail = async (name: string) => {
		try {
			const data = await importApi.get(name);
			setSelectedImport(data.import);
		} catch (err) {
			console.error("Failed to load import:", err);
		}
	};

	// Handle add import
	const handleAddImport = async (overrideDryRun?: boolean) => {
		if (!addSource.trim()) return;
		const dryRun = overrideDryRun ?? addDryRun;
		setAdding(true);
		setAddError(null);
		if (dryRun) {
			setAddResult(null);
		}
		try {
			const result = await importApi.add({
				source: addSource,
				name: addName || undefined,
				type: addType || undefined,
				ref: addRef || undefined,
				link: addLink,
				dryRun,
			});
			setAddResult(result);
			if (!dryRun) {
				loadImports();
				setShowAddModal(false);
				resetAddForm();
			}
		} catch (err) {
			setAddError(err instanceof Error ? err.message : String(err));
		} finally {
			setAdding(false);
		}
	};

	// Handle sync
	const handleSync = async (name: string) => {
		setSyncingImport(name);
		try {
			await importApi.sync(name);
			loadImports();
			toast.success(`Synced "${name}"`);
		} catch (err) {
			console.error("Failed to sync:", err);
			toast.error(`Failed to sync "${name}"`);
		} finally {
			setSyncingImport(null);
		}
	};

	// Handle remove
	const handleRemove = async () => {
		if (!selectedImport) return;
		setRemovingImport(selectedImport.name);
		try {
			await importApi.remove(selectedImport.name, removeDeleteFiles);
			setShowRemoveConfirm(false);
			setSelectedImport(null);
			loadImports();
		} catch (err) {
			console.error("Failed to remove:", err);
		} finally {
			setRemovingImport(null);
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
	};

	// Close detail view
	const closeImportDetail = () => {
		setSelectedImport(null);
	};

	useEffect(() => {
		loadImports();
	}, [loadImports]);

	const autoSave = useAutoSave(config, updateConfig, initialized);

	// Initialize from global config
	useEffect(() => {
		if (!loading && !initialized) {
			setConfig(globalConfig);
			setJsonText(JSON.stringify(globalConfig, null, 2));
			setInitialized(true);
		}
	}, [globalConfig, loading, initialized]);

	useEffect(() => {
		if (initialized) {
			void refreshAll({ silent: true });
		}
	}, [initialized, refreshAll]);

	// Update helper — updates local state + triggers auto-save
	const update = useCallback(
		(patch: Partial<Config>) => {
			setConfig((prev) => {
				const next = { ...prev, ...patch };
				autoSave(next);
				return next;
			});
		},
		[autoSave],
	);

	const handleAddStatus = () => {
		if (!newStatus.trim()) return;
		const statusKey = newStatus.toLowerCase().replace(/\s+/g, "-");
		const currentStatuses = config.statuses || DEFAULT_STATUSES;
		if (currentStatuses.includes(statusKey)) {
			toast.error("Status already exists");
			return;
		}
		update({
			statuses: [...currentStatuses, statusKey],
			statusColors: { ...(config.statusColors || {}), [statusKey]: "gray" },
		});
		setNewStatus("");
	};

	const handleRemoveStatus = (status: string) => {
		const currentStatuses = config.statuses || DEFAULT_STATUSES;
		const newColors = { ...(config.statusColors || {}) };
		delete newColors[status];
		update({
			statuses: currentStatuses.filter((s) => s !== status),
			statusColors: newColors,
			visibleColumns: (config.visibleColumns || []).filter((c) => c !== status),
		});
	};

	const handleJsonSave = async () => {
		setSaving(true);
		try {
			const parsed = JSON.parse(jsonText);
			setConfig(parsed);
			setJsonError(null);
			await updateConfig(parsed);
			toast.success("Saved", { duration: 1500, position: "bottom-right" });
		} catch (e) {
			if (e instanceof SyntaxError) {
				setJsonError("Invalid JSON syntax");
			} else {
				toast.error("Failed to save");
			}
		} finally {
			setSaving(false);
		}
	};

	const updateOpenCodeServer = useCallback(
		(patch: NonNullable<Config["opencodeServer"]>) => {
			update({
				opencodeServer: {
					...(config.opencodeServer || {}),
					...patch,
				},
			});
		},
		[config.opencodeServer, update],
	);

	const { modelCatalog, updateModelPref, toggleProviderHidden, setDefaultModel } = useOpenCodeModelManager({
		settings: config.opencodeModels,
		providerResponse,
		status: openCodeStatus,
		lastLoadedAt,
		onChange: async (nextSettings) => {
			await saveUserPreferences({ opencodeModels: nextSettings });
			update({ opencodeModels: nextSettings });
		},
	});

	// Runtime services state
	const [services, setServices] = useState<RuntimeService[]>([]);
	const [servicesLoading, setServicesLoading] = useState(true);

	// Embedding models state
	const [embeddingModels, setEmbeddingModels] = useState<EmbeddingModelsResponse | null>(null);
	const [modelsLoading, setModelsLoading] = useState(true);

	// LSP language management state
	const [availableLangs, setAvailableLangs] = useState<LSPLanguageInfo[]>([]);
	const [showAddDropdown, setShowAddDropdown] = useState(false);
	const [lspActionsLoading, setLspActionsLoading] = useState<Record<string, boolean>>({});
	const [lspConfigDrafts, setLspConfigDrafts] = useState<Record<string, LSPConfigDraft>>({});
	const [lspLogPanels, setLspLogPanels] = useState<Record<string, LSPLogPanelState>>({});
	const [lspTraceEnabled, setLspTraceEnabled] = useState<Record<string, boolean>>({});
	const dropdownRef = useRef<HTMLDivElement>(null);

	// Close LSP dropdown on outside click
	useEffect(() => {
		if (!showAddDropdown) return;
		const handler = (e: MouseEvent) => {
			if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
				setShowAddDropdown(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [showAddDropdown]);

	const refreshLspLanguages = useCallback(async () => {
		const data = await lspApi.getLanguages();
		const languages = data.languages || [];
		setAvailableLangs(languages);
		setLspTraceEnabled((prev) => {
			const next = { ...prev };
			for (const lang of languages) {
				next[lang.id] = lang.traceEnabled ?? false;
			}
			return next;
		});
		return languages;
	}, []);

	// Load available LSP languages
	useEffect(() => {
		refreshLspLanguages().catch(() => {});
	}, [refreshLspLanguages]);

	// API endpoint test state
	const [apiBase, setApiBase] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [testModelName, setTestModelName] = useState("");
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<EmbeddingModelTestResult | null>(null);

	const loadRuntimeServices = useCallback(async () => {
		try {
			setServicesLoading(true);
			const data = await getRuntimeServices();
			setServices(data.services);
		} catch {
			setServices([]);
		} finally {
			setServicesLoading(false);
		}
	}, []);

	// Load embedding models on mount and when provider changes
	const loadEmbeddingModels = useCallback(async () => {
		try {
			setModelsLoading(true);
			const data = await getEmbeddingModels();
			setEmbeddingModels(data);
		} catch (err) {
			console.error("Failed to load embedding models:", err);
		} finally {
			setModelsLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadEmbeddingModels();
	}, [loadEmbeddingModels]);

	useEffect(() => {
		if (!initialized || config.semanticSearch?.provider !== "api") return;
		setApiBase((current) => current || "http://localhost:11434/v1");
		setTestModelName((current) => current || config.semanticSearch?.model || "");
	}, [initialized, config.semanticSearch?.provider, config.semanticSearch?.model]);

	// Select embedding model and update config
	const selectEmbeddingModel = useCallback((model: EmbeddingModelInfo) => {
		const isApi = model.source === "ollama" || model.provider !== undefined;
		const modelName = model.name;
		const patch: Partial<Config> = {
			semanticSearch: {
				...(config.semanticSearch || {}),
				model: modelName,
				dimensions: model.dimensions || config.semanticSearch?.dimensions || 384,
				...(isApi ? {
					huggingFaceId: "",
				} : {
					huggingFaceId: model.huggingFaceId || "",
				}),
			},
		};
		setConfig(prev => {
			const next = { ...prev, ...patch };
			autoSave(next);
			return next;
		});
	}, [config.semanticSearch, autoSave]);

	// Test embedding API endpoint
	const handleTestEmbedding = async () => {
		if (!apiBase.trim() || !testModelName.trim()) return;
		setTesting(true);
		setTestResult(null);
		try {
			const data = await testEmbeddingModel({
				apiBase: apiBase.trim(),
				apiKey: apiKey.trim(),
				model: testModelName.trim(),
			});
			setTestResult(data);
			if (data.success) {
				update({
					semanticSearch: {
						...(config.semanticSearch || {}),
						model: testModelName.trim(),
						dimensions: data.dimensions,
					},
				});
				toast.success(`Model works! ${data.dimensions} dimensions detected.`);
			}
		} catch (err) {
			setTestResult({ success: false, error: err instanceof Error ? err.message : "Request failed" });
		} finally {
			setTesting(false);
		}
	};

	// Helper to determine if a model is selected
	const isModelSelected = useCallback((model: EmbeddingModelInfo): boolean => {
		const ss = config.semanticSearch;
		if (!ss?.model) return false;
		return ss.model === model.name;
	}, [config.semanticSearch]);

	if (loading) {
		return (
			<div className="p-6 flex items-center justify-center h-64">
				<div className="text-lg text-muted-foreground">Loading configuration...</div>
			</div>
		);
	}

	const statuses = config.statuses || DEFAULT_STATUSES;
	const statusColors = config.statusColors || {};

	// ── Filter categories based on chatUI visibility ──────────────

	const categories = ALL_CATEGORIES.filter((cat) => cat.id !== "ai" || chatUIEnabled);

	// ── Render category content ───────────────────────────────────

	const renderGeneral = () => (
		<div>
			<SectionHeader icon={Settings} title="Project" description="Basic project information" />

			<FieldRow label="Project name" hint="Display name for your project">
				<Input
					value={config.name || ""}
					onChange={(e) => update({ name: e.target.value })}
					placeholder="My Project"
				/>
			</FieldRow>

			<Separator className="my-1" />

			<SectionHeader icon={User} title="Defaults" description="Default values for new tasks" />

			<FieldRow label="Assignee" hint="Default assignee for new tasks">
				<Input
					value={config.defaultAssignee || ""}
					onChange={(e) => update({ defaultAssignee: e.target.value })}
					placeholder="@username"
				/>
			</FieldRow>

			<FieldRow label="Priority">
				<select
					value={config.defaultPriority || "medium"}
					onChange={(e) => update({ defaultPriority: e.target.value as Config["defaultPriority"] })}
					className="w-full px-3 py-2 rounded-md border bg-input text-sm focus:outline-none focus:ring-2 focus:ring-ring"
				>
					<option value="low">Low</option>
					<option value="medium">Medium</option>
					<option value="high">High</option>
				</select>
			</FieldRow>

			<FieldRow label="Labels" hint="Comma-separated">
				<Input
					value={config.defaultLabels?.join(", ") || ""}
					onChange={(e) =>
						update({
							defaultLabels: e.target.value
								.split(",")
								.map((l) => l.trim())
								.filter(Boolean),
						})
					}
					placeholder="frontend, backend, ui"
				/>
			</FieldRow>

			<Separator className="my-1" />

			<SectionHeader icon={Clock} title="Preferences" description="Display and editor settings" />

			<FieldRow label="Time format">
				<select
					value={config.timeFormat || "24h"}
					onChange={(e) => update({ timeFormat: e.target.value as Config["timeFormat"] })}
					className="w-full px-3 py-2 rounded-md border bg-input text-sm focus:outline-none focus:ring-2 focus:ring-ring"
				>
					<option value="12h">12-hour (AM/PM)</option>
					<option value="24h">24-hour</option>
				</select>
			</FieldRow>

			<FieldRow label="Editor" hint="CLI editor command">
				<Input
					value={config.editor || ""}
					onChange={(e) => update({ editor: e.target.value })}
					placeholder="code, vim, nano"
				/>
			</FieldRow>
		</div>
	);

	const renderBoard = () => (
		<div>
			<SectionHeader icon={Tag} title="Task Statuses" description="Define statuses and their colors for the Kanban board" />

			<div className="space-y-1.5 mb-4">
				{statuses.map((status) => (
					<div key={status} className="flex items-center gap-3 px-3 py-2 rounded-md bg-accent/50 hover:bg-accent transition-colors">
						<Palette className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
						<span className="flex-1 font-mono text-sm">{status}</span>
						<select
							value={statusColors[status] || "gray"}
							onChange={(e) => update({ statusColors: { ...(config.statusColors || {}), [status]: e.target.value } })}
							className="px-2 py-1 rounded border bg-input text-xs focus:outline-none focus:ring-2 focus:ring-ring"
						>
							{COLOR_OPTIONS.map((color) => (
								<option key={color} value={color}>{color}</option>
							))}
						</select>
						<button
							type="button"
							onClick={() => handleRemoveStatus(status)}
							className="p-1 text-muted-foreground hover:text-destructive rounded transition-colors"
						>
							<Trash2 className="w-3.5 h-3.5" />
						</button>
					</div>
				))}
			</div>

			<div className="flex gap-2 mb-6">
				<Input
					value={newStatus}
					onChange={(e) => setNewStatus(e.target.value)}
					placeholder="new-status"
					className="flex-1"
					onKeyDown={(e) => e.key === "Enter" && handleAddStatus()}
				/>
				<Button size="sm" onClick={handleAddStatus} variant="outline">
					<Plus className="w-4 h-4 mr-1" />
					Add
				</Button>
			</div>

			<Separator className="my-4" />

			<SectionHeader icon={Eye} title="Visible Columns" description="Choose which columns appear on the Kanban board" />

			<div className="space-y-1">
				{statuses.map((column) => {
					const isVisible = config.visibleColumns?.includes(column) ?? true;
					const label = column
						.split("-")
						.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
						.join(" ");

					return (
						<div
							key={column}
							className="flex items-center justify-between px-3 py-2.5 rounded-md hover:bg-accent/50 transition-colors"
						>
							<span className="text-sm">{label}</span>
							<Switch
								checked={isVisible}
								onCheckedChange={(checked) => {
									const current = config.visibleColumns || statuses;
									const updated = checked
										? [...current, column]
										: current.filter((c) => c !== column);
									update({ visibleColumns: updated });
								}}
							/>
						</div>
					);
				})}
			</div>
		</div>
	);

	const renderEmbeddingModels = () => {
		const provider = config.semanticSearch?.provider || "local";
		const models = provider === "local"
			? embeddingModels?.local || []
			: provider === "ollama"
				? embeddingModels?.api || []
				: embeddingModels?.configured || [];

		const hintByProvider: Record<string, string> = {
			local: "Select a local ONNX model",
			ollama: "Select an Ollama embedding model",
			api: "Select a configured API model",
		};

		return (
			<FieldRow label="Model" hint={hintByProvider[provider] || "Select a model"}>
				{modelsLoading ? (
					<div className="flex items-center justify-center py-4">
						<Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
					</div>
				) : models.length === 0 ? (
					<div className="text-sm text-muted-foreground py-2">
						{provider === "ollama"
							? "No Ollama embedding models found. Ensure Ollama is running and has embedding models pulled."
							: provider === "api"
								? "No configured API models. Use the endpoint config below to test and add one."
								: "No local models found."}
					</div>
				) : (
					<div className="space-y-2">
						{models.map((model) => {
							const selected = isModelSelected(model);
							return (
								<div
									key={model.name}
									className={`flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 cursor-pointer transition-colors ${selected ? "ring-2 ring-primary" : ""}`}
									onClick={() => selectEmbeddingModel(model)}
								>
									<div className="flex-1">
										<div className="text-sm font-medium">{model.name}</div>
										<div className="text-xs text-muted-foreground">{model.dimensions}d{model.maxTokens ? `, ${model.maxTokens} tokens` : ""}</div>
									</div>
									{"installed" in model && model.installed !== undefined ? (
										model.installed ? (
											<Badge variant="default">Installed</Badge>
										) : (
											<Badge variant="outline">Not installed</Badge>
										)
									) : null}
									{selected && <Check className="w-4 h-4 text-primary" />}
								</div>
							);
						})}
					</div>
				)}
			</FieldRow>
		);
	};

	const renderSearch = () => (
		<div>
			<SectionHeader icon={Search} title="Semantic Search" description="Configure embedding model and provider for semantic search" />

			<FieldRow label="Enabled">
				<Switch
					checked={config.semanticSearch?.enabled ?? false}
					onCheckedChange={(checked) => update({ semanticSearch: { ...(config.semanticSearch || {}), enabled: checked } })}
				/>
			</FieldRow>

			<FieldRow label="Provider" hint="local = ONNX built-in, ollama = local Ollama server, api = custom endpoint">
				<select
					value={config.semanticSearch?.provider || "local"}
					onChange={(e) => {
						update({ semanticSearch: { ...(config.semanticSearch || {}), provider: e.target.value } });
						void loadEmbeddingModels();
					}}
					className="w-full px-3 py-2 rounded-md border bg-input text-sm focus:outline-none focus:ring-2 focus:ring-ring"
				>
					<option value="local">Local (ONNX)</option>
					<option value="ollama">Ollama</option>
					<option value="api">API (OpenAI-compatible)</option>
				</select>
			</FieldRow>

			{renderEmbeddingModels()}

			{config.semanticSearch?.provider === "api" && (
				<>
					<Separator className="my-4" />
					<SectionHeader icon={Search} title="API Endpoint" description="Configure a custom OpenAI-compatible embedding endpoint" />

					<FieldRow label="API Base URL" hint="e.g. http://localhost:11434/v1">
						<Input value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="http://localhost:11434/v1" />
					</FieldRow>

					<FieldRow label="API Key" hint="Optional Bearer token">
						<Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Leave empty for local providers" />
					</FieldRow>

					<FieldRow label="Model name" hint="Model to send in API request">
						<div className="flex gap-2">
							<Input value={testModelName} onChange={(e) => setTestModelName(e.target.value)} placeholder="e.g. text-embedding-3-small" className="flex-1" />
							<Button onClick={() => void handleTestEmbedding()} disabled={testing} variant="outline" size="sm">
								{testing ? <Loader2 className="w-4 h-4 animate-spin" /> : "Test"}
							</Button>
						</div>
					</FieldRow>

					{testResult && (
						<div className={`ml-[calc(11rem+1rem)] rounded-lg border p-3 text-sm ${testResult.success ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"}`}>
							{testResult.success ? `Detected ${testResult.dimensions} dimensions` : testResult.error}
						</div>
					)}
				</>
			)}

			{(!config.semanticSearch?.provider || config.semanticSearch.provider === "local") && (
				<FieldRow label="HuggingFace ID" hint="Full HuggingFace model identifier (read-only when model is selected)">
					<Input
						value={config.semanticSearch?.huggingFaceId || ""}
						onChange={(e) => update({ semanticSearch: { ...(config.semanticSearch || {}), huggingFaceId: e.target.value } })}
						placeholder="Select a model above"
						readOnly={!!config.semanticSearch?.huggingFaceId}
					/>
				</FieldRow>
			)}

			<FieldRow label="Dimensions" hint="Embedding vector size">
				<Input
					type="number"
					value={config.semanticSearch?.dimensions ?? 384}
					onChange={(e) => update({ semanticSearch: { ...(config.semanticSearch || {}), dimensions: parseInt(e.target.value, 10) || 384 } })}
				/>
			</FieldRow>

			<FieldRow label="Max Tokens" hint="Maximum tokens per chunk">
				<Input
					type="number"
					value={config.semanticSearch?.maxTokens ?? 512}
					onChange={(e) => update({ semanticSearch: { ...(config.semanticSearch || {}), maxTokens: parseInt(e.target.value, 10) || 512 } })}
				/>
			</FieldRow>
		</div>
	);

	const renderCode = () => {
		const languages = config.lsp?.languages || {};
		const languageEntries = Object.entries(languages);

		const setActionLoading = (key: string, value: boolean) => {
			setLspActionsLoading((prev) => ({ ...prev, [key]: value }));
		};

		const updateLocalLanguage = (langId: string, nextConfig: Record<string, unknown>) => {
			setConfig((prev) => {
				const newLangs = {
					...(prev.lsp?.languages || {}),
					[langId]: { ...(prev.lsp?.languages?.[langId] || {}), ...nextConfig },
				};
				return { ...prev, lsp: { ...(prev.lsp || {}), enabled: true, languages: newLangs } };
			});
		};

		const handleAddLanguage = async (langId: string) => {
			setActionLoading(langId, true);
			setShowAddDropdown(false);
			try {
				await lspApi.addLanguage(langId);
				setConfig((prev) => {
					const newLangs = {
						...(prev.lsp?.languages || {}),
						[langId]: { ...(prev.lsp?.languages?.[langId] || {}), enabled: true },
					};
					const next = { ...prev, lsp: { ...(prev.lsp || {}), enabled: true, languages: newLangs } };
					autoSave(next);
					return next;
				});
				toast.success(`Added ${langId} language server`);
			} catch (err) {
				toast.error(err instanceof Error ? err.message : "Failed to add language");
			} finally {
				setActionLoading(langId, false);
				refreshLspLanguages().catch(() => {});
			}
		};

		const handleToggleLanguage = async (langId: string, enabled: boolean) => {
			setActionLoading(langId, true);
			try {
				await lspApi.toggleLanguage(langId, enabled);
				setConfig((prev) => {
					const langConfig = prev.lsp?.languages?.[langId];
					if (langConfig) {
						const newLangs = { ...prev.lsp!.languages, [langId]: { ...langConfig, enabled } };
						const next = { ...prev, lsp: { ...(prev.lsp || {}), languages: newLangs } };
						autoSave(next);
						return next;
					}
					return prev;
				});
			} catch (err) {
				toast.error(err instanceof Error ? err.message : "Failed to toggle language");
			} finally {
				setActionLoading(langId, false);
				refreshLspLanguages().catch(() => {});
			}
		};

		const handleRemoveLanguage = async (langId: string) => {
			setActionLoading(langId, true);
			try {
				await lspApi.removeLanguage(langId);
				setConfig((prev) => {
					const newLangs = { ...(prev.lsp?.languages || {}) };
					delete newLangs[langId];
					const next = { ...prev, lsp: { ...(prev.lsp || {}), languages: newLangs } };
					autoSave(next);
					return next;
				});
				toast.success(`Removed ${langId} language server`);
			} catch (err) {
				toast.error(err instanceof Error ? err.message : "Failed to remove language");
			} finally {
				setActionLoading(langId, false);
				refreshLspLanguages().catch(() => {});
			}
		};

		const handleRestartLanguage = async (langId: string) => {
			const key = `${langId}:restart`;
			setActionLoading(key, true);
			try {
				await lspApi.restartLanguage(langId);
				toast.success(`Restarted ${langId}`);
				await refreshLspLanguages();
			} catch (err) {
				toast.error(err instanceof Error ? err.message : "Failed to restart language server");
			} finally {
				await refreshLspLanguages().catch(() => []);
				setActionLoading(key, false);
			}
		};

		const handleInstallLanguage = async (langId: string, action: "install" | "update") => {
			const key = `${langId}:${action}`;
			setActionLoading(key, true);
			try {
				await lspApi.installLanguage(langId, action);
				toast.success(`${action === "install" ? "Installed" : "Updated"} ${langId}`);
				await refreshLspLanguages();
			} catch (err) {
				toast.error(err instanceof Error ? err.message : `Failed to ${action} dependency`);
			} finally {
				await refreshLspLanguages().catch(() => []);
				setActionLoading(key, false);
			}
		};

		const handleCleanupLanguage = async (langId: string) => {
			const key = `${langId}:cleanup`;
			setActionLoading(key, true);
			try {
				await lspApi.cleanupLanguage(langId);
				toast.success(`Cleaned ${langId} dependencies`);
				await refreshLspLanguages();
			} catch (err) {
				toast.error(err instanceof Error ? err.message : "Failed to cleanup dependencies");
			} finally {
				await refreshLspLanguages().catch(() => []);
				setActionLoading(key, false);
			}
		};

		const handleConfigDraft = (langId: string, field: keyof LSPConfigDraft, value: string) => {
			setLspConfigDrafts((prev) => ({ ...prev, [langId]: { ...(prev[langId] || {}), [field]: value } }));
		};

		const handleApplyLanguageConfig = async (langId: string, langConfig: Record<string, any>, info: LSPLanguageInfo | undefined, apply: boolean) => {
			const key = `${langId}:config`;
			const draft = lspConfigDrafts[langId] || {};
			const patch = {
				backend: draft.backend ?? langConfig.backend ?? "auto",
				projectPath: draft.projectPath ?? langConfig.projectPath ?? "",
				version: draft.version ?? langConfig.version ?? info?.version ?? "",
				binary: draft.binary ?? langConfig.binary ?? "",
				apply,
			};
			setActionLoading(key, true);
			try {
				await lspApi.updateLanguageConfig(langId, patch);
				const { apply: _apply, ...localPatch } = patch;
				updateLocalLanguage(langId, localPatch);
				setLspConfigDrafts((prev) => ({ ...prev, [langId]: {} }));
				toast.success(apply ? `Applied and restarted ${langId}` : `Updated ${langId} settings`);
				await refreshLspLanguages();
			} catch (err) {
				toast.error(err instanceof Error ? err.message : "Failed to update LSP config");
			} finally {
				await refreshLspLanguages().catch(() => []);
				setActionLoading(key, false);
			}
		};

		const handleLoadLogs = async (langId: string, kind: LSPLogKind = lspLogPanels[langId]?.kind || "runtime") => {
			setLspLogPanels((prev) => ({ ...prev, [langId]: { ...(prev[langId] || { kind, content: "" }), kind, loading: true } }));
			try {
				const data = await lspApi.getLanguageLogs(langId, kind, 200);
				setLspLogPanels((prev) => ({
					...prev,
					[langId]: { kind: data.kind, content: data.content, path: data.logPath, loading: false },
				}));
			} catch (err) {
				setLspLogPanels((prev) => ({ ...prev, [langId]: { kind, content: err instanceof Error ? err.message : "Failed to load logs", loading: false } }));
			}
		};

		const handleTraceToggle = async (langId: string, enabled: boolean) => {
			const key = `${langId}:trace`;
			setActionLoading(key, true);
			try {
				const data = await lspApi.setLanguageTrace(langId, enabled);
				setLspTraceEnabled((prev) => ({ ...prev, [langId]: data.enabled }));
				toast.success(data.enabled ? `Trace enabled for ${langId}` : `Trace disabled for ${langId}`);
				if (data.enabled) {
					await handleLoadLogs(langId, "trace");
				}
			} catch (err) {
				toast.error(err instanceof Error ? err.message : "Failed to update trace");
			} finally {
				setActionLoading(key, false);
			}
		};

		const configuredIds = new Set(Object.keys(languages));
		const unconfiguredLangs = availableLangs.filter((lang) => !configuredIds.has(lang.id));

		return (
			<div>
				<SectionHeader icon={Code2} title="Language Server Protocol" description="LSP servers for code intelligence" />

				<FieldRow label="Enabled">
					<Switch
						checked={config.lsp?.enabled ?? false}
						onCheckedChange={(checked) =>
							update({ lsp: { ...(config.lsp || {}), enabled: checked } })
						}
					/>
				</FieldRow>

				<Separator className="my-2" />
				<div className="ml-[30px] mb-3 flex items-center justify-between">
					<div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Languages</div>
					<div className="relative" ref={dropdownRef}>
						<Button
							size="sm"
							variant="outline"
							onClick={() => setShowAddDropdown(!showAddDropdown)}
							disabled={unconfiguredLangs.length === 0}
						>
							<Plus className="w-3.5 h-3.5 mr-1" />
							Add
						</Button>
						{showAddDropdown && (
							<div className="absolute right-0 top-full mt-1 z-50 min-w-48 rounded-lg border bg-popover shadow-lg">
								{unconfiguredLangs.length === 0 ? (
									<div className="px-3 py-2 text-xs text-muted-foreground">No languages available</div>
								) : (
									<div className="py-1">
										{unconfiguredLangs.map((lang) => (
											<button
												key={lang.id}
												type="button"
												className="w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center gap-2"
												onClick={() => handleAddLanguage(lang.id)}
											>
												<span className="capitalize flex-1">{lang.name}</span>
												{!lang.installed && (
													<span className="text-xs text-muted-foreground">(not installed)</span>
												)}
											</button>
										))}
									</div>
								)}
							</div>
						)}
					</div>
				</div>

				{languageEntries.length === 0 ? (
					<div className="ml-[30px] py-4 text-center border rounded-lg bg-muted/20">
						<Code2 className="w-8 h-8 mx-auto text-muted-foreground" />
						<p className="mt-2 text-sm text-muted-foreground">No language servers configured</p>
						<p className="text-xs text-muted-foreground mt-1">Click "Add" above to configure an LSP language</p>
					</div>
				) : (
					<div className="ml-[30px] space-y-3">
						{languageEntries.map(([lang, langConfig]) => {
							const info = availableLangs.find((a) => a.id === lang);
							const draft = lspConfigDrafts[lang] || {};
							const logPanel = lspLogPanels[lang];
							const isRunning = info?.running ?? false;
							const isInstalled = info?.installed ?? langConfig.binary !== undefined;
							const langEnabled = langConfig.enabled ?? true;
							const busy = Object.entries(lspActionsLoading).some(([key, value]) => value && key.startsWith(lang));
							const configBusy = lspActionsLoading[`${lang}:config`] ?? false;
							const traceOn = lspTraceEnabled[lang] ?? info?.traceEnabled ?? false;

							return (
								<div key={lang} className="overflow-hidden rounded-lg border bg-card">
									<div className="border-l-2 border-primary/50">
										<div className="border-b bg-muted/20 px-3 py-2.5">
											<div className="flex min-w-0 items-start gap-3">
												<Switch
													checked={langConfig.enabled ?? false}
													onCheckedChange={(checked) => handleToggleLanguage(lang, checked)}
													disabled={busy}
												/>
												<div className="min-w-0 space-y-1.5">
													<div className="flex flex-wrap items-center gap-2">
														<span className={`mt-0.5 h-2 w-2 rounded-full ${isRunning ? "bg-emerald-500" : langEnabled ? "bg-amber-500" : "bg-muted-foreground/50"}`} />
														<span className="truncate text-sm font-semibold">{info?.name || lang}</span>
														{busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
													</div>
													<div className="flex flex-wrap gap-1.5">
														<Badge variant={statusVariant(info?.runningState || info?.status)} className="text-[11px] font-medium">
															{displayValue(info?.runningState || info?.status)}
														</Badge>
														<Badge variant={statusVariant(info?.installState)} className="text-[11px] font-medium">
															{displayValue(info?.installState)}
														</Badge>
														<Badge variant={statusVariant(info?.readinessState)} className="text-[11px] font-medium">
															{displayValue(info?.readinessState)}
														</Badge>
													</div>
												</div>
											</div>
											<div className="mt-2 flex items-start gap-1.5">
												<div className="grid min-w-0 flex-1 grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))] gap-1.5">
													<Button className="h-7 px-2" size="sm" variant="outline" onClick={() => handleRestartLanguage(lang)} disabled={busy || !langEnabled}>
														<RefreshCw className="w-3.5 h-3.5 mr-1" />
														Restart
													</Button>
													<Button className="h-7 px-2" size="sm" variant="outline" onClick={() => handleInstallLanguage(lang, "install")} disabled={busy || !info?.installHint}>
														<Download className="w-3.5 h-3.5 mr-1" />
														Install
													</Button>
													<Button className="h-7 px-2" size="sm" variant="outline" onClick={() => handleInstallLanguage(lang, "update")} disabled={busy || !isInstalled}>
														<Package className="w-3.5 h-3.5 mr-1" />
														Update
													</Button>
													<Button className="h-7 px-2" size="sm" variant="outline" onClick={() => handleCleanupLanguage(lang)} disabled={busy || !info?.cleanupEligible}>
														<X className="w-3.5 h-3.5 mr-1" />
														Cleanup
													</Button>
													<Button className="h-7 px-2" size="sm" variant="outline" onClick={() => handleLoadLogs(lang)} disabled={busy}>
														<Terminal className="w-3.5 h-3.5 mr-1" />
														Logs
													</Button>
													<Button className="h-7 px-2" size="sm" variant={traceOn ? "default" : "outline"} onClick={() => handleTraceToggle(lang, !traceOn)} disabled={busy}>
														<Activity className="w-3.5 h-3.5 mr-1" />
														Trace
													</Button>
												</div>
												<Button aria-label={`Remove ${info?.name || lang}`} className="h-7 w-7 shrink-0 px-0 text-muted-foreground hover:text-destructive" size="sm" variant="outline" onClick={() => handleRemoveLanguage(lang)} disabled={busy}>
													<Trash2 className="h-3.5 w-3.5" />
												</Button>
											</div>
										</div>

										<div className="grid grid-cols-[repeat(auto-fit,minmax(11.5rem,1fr))] gap-2 p-3">
											<div className="min-w-0 rounded-md border bg-background/60 px-2.5 py-2">
												<div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Backend</div>
												<div className="mt-1 break-words font-mono text-[11px] leading-5 text-foreground">{displayValue(info?.backend)}{info?.backendSource ? ` (${info.backendSource})` : ""}</div>
											</div>
											<div className="min-w-0 rounded-md border bg-background/60 px-2.5 py-2">
												<div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Project</div>
												<div className="mt-1 break-words font-mono text-[11px] leading-5 text-foreground">{displayValue(info?.projectPath)}{info?.projectKind ? ` (${info.projectKind})` : ""}</div>
											</div>
											<div className="min-w-0 rounded-md border bg-background/60 px-2.5 py-2">
												<div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Binary</div>
												<div className="mt-1 break-words font-mono text-[11px] leading-5 text-foreground">{displayValue(info?.binaryPath || info?.binary || langConfig.binary)}</div>
											</div>
											<div className="min-w-0 rounded-md border bg-background/60 px-2.5 py-2">
												<div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Version</div>
												<div className="mt-1 break-words font-mono text-[11px] leading-5 text-foreground">{displayValue(info?.version || langConfig.version)}</div>
											</div>
											<div className="min-w-0 rounded-md border bg-background/60 px-2.5 py-2">
												<div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Cache</div>
												<div className="mt-1 break-words font-mono text-[11px] leading-5 text-foreground">{displayValue(info?.cachePath)}</div>
											</div>
											<div className="min-w-0 rounded-md border bg-background/60 px-2.5 py-2">
												<div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Log</div>
												<div className="mt-1 break-words font-mono text-[11px] leading-5 text-foreground">{displayValue(info?.logPath)}</div>
											</div>
										</div>

										{info?.installHint && !isInstalled && (
											<div className="mx-3 mb-3 rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">Install: <code className="text-xs">{info.installHint}</code></div>
										)}
										{(info?.installError || info?.updateError) && (
											<div className="mx-3 mb-3 flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
												<AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
												<span>{info.installError || info.updateError}</span>
											</div>
										)}
										{info?.attempts && info.attempts.length > 0 && (
											<div className="mx-3 mb-3 flex flex-wrap gap-1.5">
												{info.attempts.map((attempt, index) => (
													<Badge key={`${attempt.backend}-${index}`} variant={statusVariant(attempt.status)} className="text-xs font-normal">
														{attempt.backend}: {attempt.status}{attempt.reason ? ` - ${attempt.reason}` : ""}
													</Badge>
												))}
											</div>
										)}
									</div>

									{lang === "csharp" && (
										<div className="m-3 mt-0 grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2 rounded-md border bg-muted/20 p-3">
											<select
												value={draft.backend ?? langConfig.backend ?? "auto"}
												onChange={(e) => handleConfigDraft(lang, "backend", e.target.value)}
												className="px-3 py-2 rounded-md border bg-input text-sm focus:outline-none focus:ring-2 focus:ring-ring"
												disabled={configBusy}
											>
												{CSHARP_BACKENDS.map((backend) => (
													<option key={backend} value={backend}>{backend}</option>
												))}
											</select>
											<Input
												value={draft.projectPath ?? langConfig.projectPath ?? ""}
												onChange={(e) => handleConfigDraft(lang, "projectPath", e.target.value)}
												placeholder={info?.projectPath || "solution or project path"}
												disabled={configBusy}
											/>
											<Input
												value={draft.version ?? langConfig.version ?? ""}
												onChange={(e) => handleConfigDraft(lang, "version", e.target.value)}
												placeholder="version override"
												disabled={configBusy}
											/>
											<Button size="sm" onClick={() => handleApplyLanguageConfig(lang, langConfig, info, true)} disabled={configBusy || !langEnabled}>
												{configBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <CheckCircle2 className="w-3.5 h-3.5 mr-1" />}
												Apply
											</Button>
										</div>
									)}

									{logPanel && (
										<div className="m-3 mt-0 overflow-hidden rounded-md border bg-muted/20">
											<div className="grid gap-2 border-b px-3 py-2 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
												<div className="flex items-center gap-1">
													<Button className="h-7 px-2" size="sm" variant={logPanel.kind === "runtime" ? "default" : "outline"} onClick={() => handleLoadLogs(lang, "runtime")}>
														Runtime
													</Button>
													<Button className="h-7 px-2" size="sm" variant={logPanel.kind === "trace" ? "default" : "outline"} onClick={() => handleLoadLogs(lang, "trace")}>
														Trace
													</Button>
												</div>
												<span className="min-w-0 truncate rounded bg-background/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">{displayValue(logPanel.path || info?.logPath)}</span>
												<div className="flex items-center gap-1 justify-self-start sm:justify-self-end">
													<Button className="h-7 w-7 px-0" size="sm" variant="outline" onClick={() => navigator.clipboard?.writeText(logPanel.path || info?.logPath || "")}>
														<Copy className="h-3.5 w-3.5" />
													</Button>
													<Button className="h-7 w-7 px-0" size="sm" variant="outline" onClick={() => handleLoadLogs(lang, logPanel.kind)} disabled={logPanel.loading}>
														{logPanel.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
													</Button>
												</div>
											</div>
											<pre className="max-h-64 overflow-auto whitespace-pre-wrap p-3 text-xs font-mono text-muted-foreground">
												{logPanel.loading ? "Loading..." : logPanel.content || "No log output"}
											</pre>
										</div>
									)}
								</div>
							);
						})}
					</div>
				)}

				<Separator className="my-4" />

				<SectionHeader icon={Code2} title="Code Intelligence Ignore" description="Patterns to exclude from code analysis" />

				<FieldRow label="Ignore patterns" hint="One pattern per line">
					<textarea
						value={(config.codeIntelligenceIgnore || []).join("\n")}
						onChange={(e) =>
							update({
								codeIntelligenceIgnore: e.target.value
									.split("\n")
									.map((l) => l.trim())
									.filter(Boolean),
							})
						}
						className="w-full h-32 px-3 py-2 rounded-md border bg-input text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring resize-none"
						placeholder={"node_modules/\ndist/\n*.test.ts\n*.spec.ts"}
					/>
				</FieldRow>
			</div>
		);
	};

	const renderAI = () => {
		const statusTone = openCodeStatusLoading
			? "border-border bg-muted/40 text-muted-foreground"
			: openCodeStatus?.available
				? "border-emerald-200 bg-emerald-50 text-emerald-700"
				: "border-amber-200 bg-amber-50 text-amber-700";

		return (
			<div>
				<SectionHeader icon={Bot} title="OpenCode" description="Configure the OpenCode server used by Chat UI" />

				<FieldRow label="Connection" hint="Chat UI is blocked when OpenCode is unavailable">
					<div className="space-y-3">
						<div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${statusTone}`}>
							{openCodeStatusLoading ? (
								<Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
							) : openCodeStatus?.available ? (
								<CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
							) : (
								<AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
							)}
							<div className="min-w-0">
								<div className="font-medium">
									{openCodeStatusLoading
										? "Checking OpenCode..."
										: openCodeStatus?.available
											? `Connected to ${openCodeStatus.host}:${openCodeStatus.port}`
											: openCodeStatus?.error || "OpenCode is unavailable."}
								</div>
								{!openCodeStatusLoading && !openCodeStatus?.cliAvailable && (
									<div className="mt-1 text-xs opacity-80">
										`opencode` CLI was not found, so auto-start is unavailable.
									</div>
								)}
							</div>
						</div>
						<Button variant="outline" size="sm" onClick={() => void refreshAll()} disabled={openCodeStatusLoading || providersLoading}>
							{openCodeStatusLoading || providersLoading ? "Checking..." : "Refresh status"}
						</Button>
					</div>
				</FieldRow>

				<FieldRow label="Password" hint="Optional basic auth password">
					<Input
						type="password"
						value={config.opencodeServer?.password || ""}
						onChange={(e) => updateOpenCodeServer({ password: e.target.value })}
						placeholder="Leave empty if OpenCode has no password"
					/>
				</FieldRow>

				<Separator className="my-4" />

				<SectionHeader
					icon={Bot}
					title="Model Manager"
					description="Enable models, choose the project default, and control what appears in the chat picker"
				/>

				<FieldRow label="Catalog" hint="Live provider/model catalog from OpenCode">
					<OpenCodeModelManager
						catalog={modelCatalog}
						lastLoadedAt={lastLoadedAt}
						onSetDefaultModel={setDefaultModel}
						onUpdateModelPref={updateModelPref}
						onToggleProviderHidden={toggleProviderHidden}
						showProviderVisibility
					/>
				</FieldRow>
			</div>
		);
	};

	const renderImports = () => (
		<div>
			<SectionHeader icon={Download} title="Imports" description="Imported templates and docs" />

			{importsLoading ? (
				<div className="flex items-center justify-center py-6">
					<Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
				</div>
			) : imports.length === 0 ? (
				<div className="py-4 text-center border rounded-lg bg-muted/20">
					<Download className="w-8 h-8 mx-auto text-muted-foreground" />
					<p className="mt-2 text-sm text-muted-foreground">No imports yet</p>
					<Button onClick={() => setShowAddModal(true)} variant="outline" size="sm" className="mt-2">
						<Plus className="w-4 h-4 mr-2" />
						Add Import
					</Button>
				</div>
			) : (
				<div className="space-y-2 mb-4">
					{imports.map((imp) => (
						<div
							key={imp.name}
							className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors cursor-pointer"
							onClick={() => loadImportDetail(imp.name)}
						>
							<div className="flex items-center gap-3 min-w-0">
								<Package className="w-4 h-4 text-muted-foreground shrink-0" />
								<div className="min-w-0">
									<div className="text-sm font-medium truncate">{imp.name}</div>
									<div className="text-xs text-muted-foreground truncate">{imp.source}</div>
								</div>
							</div>
							<div className="flex items-center gap-2">
								<span className="text-xs text-muted-foreground">{imp.fileCount} files</span>
								<ChevronRight className="w-4 h-4 text-muted-foreground" />
							</div>
						</div>
					))}
				</div>
			)}

			{imports.length > 0 && (
				<div className="flex justify-end mb-4">
					<Button onClick={() => setShowAddModal(true)} size="sm" variant="outline">
						<Plus className="w-4 h-4 mr-2" />
						Add
					</Button>
				</div>
			)}
		</div>
	);

	const statusDotClass = (status: RuntimeService["status"]) => {
		switch (status) {
			case "running":
				return "bg-emerald-500";
			case "error":
				return "bg-red-500";
			default:
				return "bg-gray-400";
		}
	};

	const renderRuntime = () => (
		<div>
			<SectionHeader icon={Monitor} title="Runtime Services" description="Managed sub-processes for this project" />

			<FieldRow label="Services" hint="Live process status from runtime">
				<div className="space-y-3">
					<div className="flex justify-end">
						<Button variant="outline" size="sm" onClick={() => void loadRuntimeServices()} disabled={servicesLoading}>
							{servicesLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
							Refresh
						</Button>
					</div>

					{servicesLoading ? (
						<div className="flex items-center justify-center py-6 rounded-lg border bg-muted/20">
							<Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
						</div>
					) : services.length === 0 ? (
						<div className="py-6 text-center border rounded-lg bg-muted/20">
							<Activity className="w-8 h-8 mx-auto text-muted-foreground" />
							<p className="mt-2 text-sm text-muted-foreground">No runtime services reported</p>
						</div>
					) : (
						<div className="space-y-2">
							{services.map((service) => {
								const running = service.status === "running";
								const disabled = service.status === "disabled" || !service.enabledInConfig;
								return (
									<div key={`${service.type}-${service.name}`} className="rounded-lg border bg-card p-3">
										<div className="flex items-start justify-between gap-3">
											<div className="flex items-start gap-3 min-w-0">
												<span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${statusDotClass(service.status)}`} />
												<div className="min-w-0">
													<div className="flex flex-wrap items-center gap-2">
														<span className="text-sm font-medium truncate">{service.name}</span>
														<span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground capitalize">{service.status}</span>
														{disabled && <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">disabled</span>}
													</div>
													<div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
														{running && service.pid ? <span>pid={service.pid}</span> : null}
														{running && service.port ? <span>:{service.port}</span> : null}
														{running && service.uptime ? <span>uptime={service.uptime}</span> : null}
													</div>
													{disabled && (
														<div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
															<PowerOff className="h-3.5 w-3.5" />
															Enable via settings or config set to start this service.
														</div>
													)}
												</div>
											</div>
											{running ? <Power className="h-4 w-4 text-emerald-600" /> : <PowerOff className="h-4 w-4 text-muted-foreground" />}
										</div>
									</div>
								);
							})}
						</div>
					)}
				</div>
			</FieldRow>

			<Separator className="my-4" />

			<SectionHeader icon={Monitor} title="Memory Limits" description="Control runtime memory process queue sizing" />

			<FieldRow label="Mode">
				<select
					value={config.runtimeMemory?.mode || "auto"}
					onChange={(e) =>
						update({ runtimeMemory: { ...(config.runtimeMemory || {}), mode: e.target.value } })
					}
					className="w-full px-3 py-2 rounded-md border bg-input text-sm focus:outline-none focus:ring-2 focus:ring-ring"
				>
					<option value="off">Off</option>
					<option value="auto">Auto</option>
					<option value="manual">Manual</option>
					<option value="debug">Debug</option>
				</select>
			</FieldRow>

			<FieldRow label="Max Items" hint="Maximum queued items (0 = unlimited)">
				<Input
					type="number"
					value={config.runtimeMemory?.maxItems ?? 0}
					onChange={(e) =>
						update({ runtimeMemory: { ...(config.runtimeMemory || {}), maxItems: parseInt(e.target.value, 10) || 0 } })
					}
				/>
			</FieldRow>

			<FieldRow label="Max Bytes" hint="Maximum memory in bytes (0 = unlimited)">
				<Input
					type="number"
					value={config.runtimeMemory?.maxBytes ?? 0}
					onChange={(e) =>
						update({ runtimeMemory: { ...(config.runtimeMemory || {}), maxBytes: parseInt(e.target.value, 10) || 0 } })
					}
				/>
			</FieldRow>
		</div>
	);

	const PLATFORM_OPTIONS = [
		{ id: "claude-code", label: "Claude Code" },
		{ id: "opencode", label: "OpenCode" },
		{ id: "gemini", label: "Gemini" },
		{ id: "copilot", label: "Copilot" },
		{ id: "agents", label: "Agents" },
	];

	// ── Tunnel state ──────────────────────────────────────────────────
	const [tunnelStatus, setTunnelStatus] = useState<{ running: boolean; url?: string }>({ running: false });
	const [tunnelLoading, setTunnelLoading] = useState(false);
	const [tunnelError, setTunnelError] = useState<string | null>(null);

	useEffect(() => {
		tunnelApi.getStatus().then(setTunnelStatus).catch(() => {});
	}, []);

	const handleTunnelStart = async () => {
		setTunnelLoading(true);
		setTunnelError(null);
		try {
			const result = await tunnelApi.start();
			setTunnelStatus({ running: true, url: result.url });
			toast.success(`Tunnel active: ${result.url}`);
		} catch (err) {
			setTunnelError(err instanceof Error ? err.message : "Failed to start tunnel");
		} finally {
			setTunnelLoading(false);
		}
	};

	const handleTunnelStop = async () => {
		setTunnelLoading(true);
		setTunnelError(null);
		try {
			await tunnelApi.stop();
			setTunnelStatus({ running: false });
			toast.success("Tunnel stopped");
		} catch (err) {
			setTunnelError(err instanceof Error ? err.message : "Failed to stop tunnel");
		} finally {
			setTunnelLoading(false);
		}
	};

	const renderTunnel = () => (
		<div>
			<SectionHeader icon={Globe} title="Cloudflare Tunnel" description="Expose this server to the internet via Cloudflare Quick Tunnel" />

			<FieldRow label="Status">
				<div className="flex items-center gap-3">
					<div className={`w-2.5 h-2.5 rounded-full ${tunnelStatus.running ? "bg-green-500" : "bg-gray-400"}`} />
					<span className="text-sm">{tunnelStatus.running ? "Running" : "Stopped"}</span>
				</div>
			</FieldRow>

			{tunnelStatus.running && tunnelStatus.url && (
				<FieldRow label="Public URL">
					<div className="flex items-center gap-2">
						<code className="text-sm bg-muted px-2 py-1 rounded flex-1 truncate">{tunnelStatus.url}</code>
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								navigator.clipboard.writeText(tunnelStatus.url!);
								toast.success("URL copied");
							}}
						>
							<Copy className="w-3.5 h-3.5" />
						</Button>
					</div>
				</FieldRow>
			)}

			{tunnelError && (
				<FieldRow label="">
					<p className="text-sm text-destructive">{tunnelError}</p>
				</FieldRow>
			)}

			<FieldRow label="Control">
				{tunnelStatus.running ? (
					<Button variant="outline" onClick={handleTunnelStop} disabled={tunnelLoading}>
						{tunnelLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <PowerOff className="w-4 h-4 mr-2" />}
						Stop Tunnel
					</Button>
				) : (
					<Button onClick={handleTunnelStart} disabled={tunnelLoading}>
						{tunnelLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Power className="w-4 h-4 mr-2" />}
						Start Tunnel
					</Button>
				)}
			</FieldRow>
		</div>
	);

	// ── Security state ────────────────────────────────────────────────
	const { isProtected, setPassword: authSetPassword, removePassword: authRemovePassword } = useAuth();
	const [newPassword, setNewPassword] = useState("");
	const [securityLoading, setSecurityLoading] = useState(false);

	const handleSetPassword = async () => {
		if (!newPassword) return;
		setSecurityLoading(true);
		try {
			await authSetPassword(newPassword);
			setNewPassword("");
			toast.success("Password protection enabled");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to set password");
		} finally {
			setSecurityLoading(false);
		}
	};

	const handleRemovePassword = async () => {
		setSecurityLoading(true);
		try {
			await authRemovePassword();
			toast.success("Password protection disabled");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to remove password");
		} finally {
			setSecurityLoading(false);
		}
	};

	const renderSecurity = () => (
		<div>
			<SectionHeader icon={Shield} title="Password Protection" description="Protect WebUI access with a password (in-memory, not persisted)" />

			<FieldRow label="Status">
				<div className="flex items-center gap-3">
					<div className={`w-2.5 h-2.5 rounded-full ${isProtected ? "bg-green-500" : "bg-yellow-500"}`} />
					<span className="text-sm">{isProtected ? "Protected" : "Unprotected"}</span>
					{!isProtected && tunnelStatus.running && (
						<span className="text-xs text-destructive">(tunnel active without password)</span>
					)}
				</div>
			</FieldRow>

			{isProtected ? (
				<FieldRow label="Action">
					<Button variant="outline" onClick={handleRemovePassword} disabled={securityLoading}>
						{securityLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <PowerOff className="w-4 h-4 mr-2" />}
						Remove Password
					</Button>
				</FieldRow>
			) : (
				<FieldRow label="Set Password">
					<div className="flex items-center gap-2">
						<Input
							type="password"
							value={newPassword}
							onChange={(e) => setNewPassword(e.target.value)}
							placeholder="Enter password"
							onKeyDown={(e) => { if (e.key === "Enter") handleSetPassword(); }}
						/>
						<Button onClick={handleSetPassword} disabled={securityLoading || !newPassword}>
							{securityLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Check className="w-4 h-4 mr-2" />}
							Set
						</Button>
					</div>
				</FieldRow>
			)}
		</div>
	);

	const renderAdvanced = () => (
		<div>
			<SectionHeader icon={Wrench} title="Git Tracking" description="Control how the .knowns directory interacts with git" />

			<FieldRow label="Mode">
				<select
					value={config.gitTrackingMode || "none"}
					onChange={(e) => update({ gitTrackingMode: e.target.value })}
					className="w-full px-3 py-2 rounded-md border bg-input text-sm focus:outline-none focus:ring-2 focus:ring-ring"
				>
					<option value="git-tracked">Git Tracked</option>
					<option value="git-ignored">Git Ignored</option>
					<option value="none">None</option>
				</select>
			</FieldRow>

			<Separator className="my-1" />

			<SectionHeader icon={Settings} title="Server" description="Network configuration" />

			<FieldRow label="Server Port" hint="Port for the Knowns server">
				<Input
					type="number"
					value={config.serverPort ?? 0}
					onChange={(e) => update({ serverPort: parseInt(e.target.value, 10) || 0 })}
				/>
			</FieldRow>

			<Separator className="my-1" />

			<SectionHeader icon={Settings} title="Platforms" description="Select which AI platforms are active" />

			<FieldRow label="Enabled platforms">
				<div className="space-y-2">
					{PLATFORM_OPTIONS.map((platform) => {
						const checked = (config.platforms || []).includes(platform.id);
						return (
							<div key={platform.id} className="flex items-center gap-3">
								<Switch
									checked={checked}
									onCheckedChange={(c) => {
										const current = config.platforms || [];
										const updated = c
											? [...current, platform.id]
											: current.filter((p) => p !== platform.id);
										update({ platforms: updated });
									}}
								/>
								<Label className="text-sm cursor-pointer">{platform.label}</Label>
							</div>
						);
					})}
				</div>
			</FieldRow>

			<Separator className="my-1" />

			<SectionHeader icon={Settings} title="Chat UI" description="Enable or disable the chat interface" />

			<FieldRow label="Enable Chat UI">
				<Switch
					checked={config.enableChatUI ?? true}
					onCheckedChange={(checked) => update({ enableChatUI: checked })}
				/>
			</FieldRow>

			<Separator className="my-4" />

			<SectionHeader icon={Terminal} title="JSON Editor" description="Raw config.json editing" />

			<div className="space-y-4">
				<div>
					<label className="block text-sm font-medium mb-2 flex items-center gap-2">
						<Terminal className="w-4 h-4 text-muted-foreground" />
						config.json
					</label>
					<textarea
						value={jsonText}
						onChange={(e) => {
							setJsonText(e.target.value);
							setJsonError(null);
						}}
						className="w-full h-[calc(100vh-480px)] min-h-[300px] px-4 py-3 rounded-lg border bg-input font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
						spellCheck={false}
					/>
					{jsonError && <p className="mt-2 text-sm text-destructive">{jsonError}</p>}
				</div>
				<Button onClick={handleJsonSave} disabled={saving}>
					<Check className="w-4 h-4 mr-2" />
					{saving ? "Saving..." : "Save"}
				</Button>
			</div>
		</div>
	);

	const contentByCategory: Record<Category, () => React.ReactNode> = {
		general: renderGeneral,
		board: renderBoard,
		search: renderSearch,
		code: renderCode,
		ai: renderAI,
		imports: renderImports,
		runtime: renderRuntime,
		tunnel: renderTunnel,
		security: renderSecurity,
		advanced: renderAdvanced,
	};

	// ── Main layout ───────────────────────────────────────────────

	return (
		<div className="h-full flex flex-col">
			{/* Top bar */}
			<div className="px-6 py-4 border-b shrink-0 flex items-center justify-between">
				<h1 className="text-lg font-semibold">Settings</h1>
				<Badge variant="outline" className="text-xs">
					{config.name || "Unknown"}
				</Badge>
			</div>

			<div className="flex-1 flex min-h-0">
				{/* Sidebar (desktop) */}
				<nav className="w-52 shrink-0 border-r bg-accent/30 p-3 hidden md:block">
					<div className="space-y-0.5">
						{categories.map((cat) => {
							const Icon = cat.icon;
							const isActive = activeCategory === cat.id;
							return (
								<button
									key={cat.id}
									type="button"
									onClick={() => setActiveCategory(cat.id)}
									className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors text-left ${
										isActive
											? "bg-accent font-medium"
											: "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
									}`}
								>
									<Icon className="w-4 h-4 shrink-0" />
									{cat.label}
								</button>
							);
						})}
					</div>
				</nav>

				{/* Mobile tabs */}
				<div className="md:hidden border-b px-4 pt-2 flex gap-1 shrink-0 overflow-x-auto">
					{categories.map((cat) => {
						const Icon = cat.icon;
						const isActive = activeCategory === cat.id;
						return (
							<button
								key={cat.id}
								type="button"
								onClick={() => setActiveCategory(cat.id)}
								className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-md transition-colors whitespace-nowrap ${
									isActive
										? "bg-background border border-b-0 text-foreground"
										: "text-muted-foreground hover:text-foreground"
								}`}
							>
								<Icon className="w-3.5 h-3.5" />
								{cat.label}
							</button>
						);
					})}
				</div>

				{/* Content */}
				<ScrollArea className="flex-1">
					<div className={`p-6 ${activeCategory === "code" ? "max-w-4xl" : "max-w-2xl"}`}>
						{contentByCategory[activeCategory]()}
					</div>
				</ScrollArea>
			</div>

			{/* Add Import Modal */}
			{showAddModal && (
				<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
					<div className="bg-card rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
						<div className="p-6 border-b">
							<h2 className="text-lg font-semibold">Add Import</h2>
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
							</div>

							<div className="grid grid-cols-2 gap-4">
								<div>
									<Label className="mb-2 block">Name (optional)</Label>
									<Input
										type="text"
										value={addName}
										onChange={(e) => setAddName(e.target.value)}
										placeholder="Auto-detect"
									/>
								</div>
								<div>
									<Label className="mb-2 block">Type (optional)</Label>
									<select
										value={addType}
										onChange={(e) => setAddType(e.target.value)}
										className="w-full px-3 py-2 rounded-lg border border-border/40 bg-background"
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

							<div className="flex items-center gap-4 p-3 rounded-lg border border-border/40 bg-muted/30">
								<Switch id="link" checked={addLink} onCheckedChange={setAddLink} />
								<Label htmlFor="link" className="text-sm cursor-pointer flex-1">
									<span className="font-medium">Symlink</span>
									<span className="text-muted-foreground ml-2">(local only)</span>
								</Label>
							</div>

							<div className="flex items-center gap-4 p-3 rounded-lg border border-border/40 bg-muted/30">
								<Switch id="dry-run" checked={addDryRun} onCheckedChange={setAddDryRun} />
								<Label htmlFor="dry-run" className="text-sm cursor-pointer flex-1">
									<span className="font-medium">Preview mode</span>
									<span className="text-muted-foreground ml-2">(no files created)</span>
								</Label>
							</div>

							{addError && (
								<div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4">
									<div className="flex items-start gap-2 text-red-600 dark:text-red-400">
										<AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
										<div className="text-sm">{addError}</div>
									</div>
								</div>
							)}

							{addResult && (
								<div className={`border rounded-lg p-4 ${addResult.dryRun ? "bg-blue-50 dark:bg-blue-950/30 border-blue-200" : "bg-green-50 dark:bg-green-950/30 border-green-200"}`}>
									<div className="font-medium">
										{addResult.dryRun ? "Preview Complete" : "Import Complete"}
									</div>
									{addResult.summary && (
										<div className="text-sm text-muted-foreground mt-1">
											{addResult.summary.added} added, {addResult.summary.updated} updated, {addResult.summary.skipped} skipped
										</div>
									)}
								</div>
							)}
						</div>

						<div className="p-6 border-t flex justify-end gap-3">
							<Button variant="secondary" onClick={() => { resetAddForm(); setShowAddModal(false); }} disabled={adding}>
								{addResult && !addResult.dryRun ? "Close" : "Cancel"}
							</Button>
							{(!addResult || addResult.dryRun) && (
								<Button
									onClick={() => {
										if (addResult && addResult.dryRun) {
											setAddDryRun(false);
											handleAddImport(false);
										} else {
											handleAddImport();
										}
									}}
									disabled={adding || !addSource.trim()}
								>
									{adding ? (
										<>
											<Loader2 className="w-4 h-4 mr-2 animate-spin" />
											{addResult && addResult.dryRun ? "Importing..." : "Checking..."}
										</>
									) : addResult && addResult.dryRun ? (
										"Import Now"
									) : (
										"Preview"
									)}
								</Button>
							)}
						</div>
					</div>
				</div>
			)}

			{/* Import Detail Modal */}
			{selectedImport && (
				<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
					<div className="bg-card rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
						<div className="p-6 border-b">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-3">
									<Package className="w-6 h-6 text-muted-foreground" />
									<div>
										<h2 className="text-lg font-semibold">{selectedImport.name}</h2>
										<p className="text-sm text-muted-foreground font-mono">{selectedImport.source}</p>
									</div>
								</div>
								<Button variant="ghost" size="sm" onClick={closeImportDetail}>
									<X className="w-4 h-4" />
								</Button>
							</div>
						</div>

						<div className="p-6 space-y-4">
							<div className="grid grid-cols-2 gap-4">
								<div>
									<div className="text-xs text-muted-foreground mb-1">Type</div>
									<div className="font-medium capitalize">{selectedImport.type}</div>
								</div>
								<div>
									<div className="text-xs text-muted-foreground mb-1">Files</div>
									<div className="font-medium">{selectedImport.fileCount} files</div>
								</div>
							</div>

							<div className="flex gap-2 pt-2">
								<Button onClick={() => handleSync(selectedImport.name)} disabled={syncingImport === selectedImport.name} variant="outline" size="sm">
									{syncingImport === selectedImport.name ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />}
									Sync
								</Button>
								<Button onClick={() => setShowRemoveConfirm(true)} variant="outline" size="sm" className="text-red-600 hover:text-red-700">
									<Trash2 className="w-4 h-4 mr-2" />
									Remove
								</Button>
							</div>
						</div>
					</div>
				</div>
			)}

			{/* Remove Confirmation Modal */}
			{showRemoveConfirm && selectedImport && (
				<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
					<div className="bg-card rounded-lg shadow-xl max-w-md w-full">
						<div className="p-6 border-b">
							<h2 className="text-lg font-semibold text-red-600">Remove Import</h2>
						</div>

						<div className="p-6 space-y-4">
							<p>Are you sure you want to remove the import <strong>{selectedImport.name}</strong>?</p>

							<div className="flex items-center gap-4 p-3 rounded-lg border border-border/40 bg-muted/30">
								<Switch id="delete-files" checked={removeDeleteFiles} onCheckedChange={setRemoveDeleteFiles} />
								<Label htmlFor="delete-files" className="text-sm cursor-pointer flex-1">
									<span className="font-medium">Also delete imported files</span>
									<span className="text-muted-foreground block text-xs mt-0.5">
										{selectedImport.fileCount} files will be permanently deleted
									</span>
								</Label>
							</div>
						</div>

						<div className="p-6 border-t flex justify-end gap-3">
							<Button variant="secondary" onClick={() => { setShowRemoveConfirm(false); setRemoveDeleteFiles(false); }} disabled={removingImport !== null}>
								Cancel
							</Button>
							<Button onClick={handleRemove} disabled={removingImport !== null} className="bg-red-600 hover:bg-red-700 text-white">
								{removingImport ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
								Remove
							</Button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
