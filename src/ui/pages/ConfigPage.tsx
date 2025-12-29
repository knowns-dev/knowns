import { useEffect, useState } from "react";
import { Settings, Check, Plus, Trash2, Code, FormInput } from "lucide-react";
import { ScrollArea } from "../components/ui/scroll-area";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useConfig, type Config } from "../contexts/ConfigContext";

type TaskStatus = string;

const DEFAULT_STATUSES = ["todo", "in-progress", "in-review", "done", "blocked", "on-hold", "urgent"];
const COLOR_OPTIONS = ["gray", "blue", "green", "yellow", "red", "purple", "orange", "pink", "cyan", "indigo"];

export default function ConfigPage() {
	const { config: globalConfig, loading, updateConfig } = useConfig();
	const [localConfig, setLocalConfig] = useState<Config>({});
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
	const [viewMode, setViewMode] = useState<"form" | "json">("form");
	const [jsonText, setJsonText] = useState("");
	const [jsonError, setJsonError] = useState<string | null>(null);
	const [newStatus, setNewStatus] = useState("");
	const [initialized, setInitialized] = useState(false);

	// Initialize local config from global config when it loads
	useEffect(() => {
		if (!loading && !initialized) {
			setLocalConfig(globalConfig);
			setJsonText(JSON.stringify(globalConfig, null, 2));
			setInitialized(true);
		}
	}, [globalConfig, loading, initialized]);

	// Use localConfig for editing, rename for clarity
	const config = localConfig;
	const setConfig = setLocalConfig;

	// Update JSON text when config changes (form mode)
	useEffect(() => {
		if (viewMode === "form") {
			setJsonText(JSON.stringify(config, null, 2));
		}
	}, [config, viewMode]);

	const handleSave = async () => {
		setSaving(true);
		setMessage(null);

		try {
			let configToSave = config;

			// If in JSON mode, parse the JSON text
			if (viewMode === "json") {
				try {
					configToSave = JSON.parse(jsonText);
					setConfig(configToSave);
					setJsonError(null);
				} catch (e) {
					setJsonError("Invalid JSON syntax");
					setSaving(false);
					return;
				}
			}

			await updateConfig(configToSave);

			setMessage({ type: "success", text: "Configuration saved successfully!" });
			setTimeout(() => setMessage(null), 3000);
		} catch (err) {
			setMessage({
				type: "error",
				text: err instanceof Error ? err.message : "Failed to save config",
			});
		} finally {
			setSaving(false);
		}
	};

	const handleAddStatus = () => {
		if (!newStatus.trim()) return;
		const statusKey = newStatus.toLowerCase().replace(/\s+/g, "-");
		const currentStatuses = config.statuses || DEFAULT_STATUSES;
		if (currentStatuses.includes(statusKey)) {
			setMessage({ type: "error", text: "Status already exists" });
			return;
		}
		setConfig({
			...config,
			statuses: [...currentStatuses, statusKey],
			statusColors: { ...(config.statusColors || {}), [statusKey]: "gray" },
		});
		setNewStatus("");
	};

	const handleRemoveStatus = (status: string) => {
		const currentStatuses = config.statuses || DEFAULT_STATUSES;
		const newColors = { ...(config.statusColors || {}) };
		delete newColors[status];
		setConfig({
			...config,
			statuses: currentStatuses.filter((s) => s !== status),
			statusColors: newColors,
			visibleColumns: (config.visibleColumns || []).filter((c) => c !== status),
		});
	};

	const handleStatusColorChange = (status: string, color: string) => {
		setConfig({
			...config,
			statusColors: { ...(config.statusColors || {}), [status]: color },
		});
	};

	if (loading) {
		return (
			<div className="p-6 flex items-center justify-center h-64">
				<div className="text-lg text-muted-foreground">Loading configuration...</div>
			</div>
		);
	}

	const statuses = config.statuses || DEFAULT_STATUSES;
	const statusColors = config.statusColors || {};

	return (
		<ScrollArea className="h-full">
		<div className="p-6 max-w-3xl">
			{/* Header */}
			<div className="mb-6 flex items-center justify-between shrink-0">
				<div className="flex items-center gap-3">
					<Settings className="w-6 h-6" />
					<h1 className="text-2xl font-bold">Configuration</h1>
				</div>

				{/* View Mode Toggle */}
				<div className="flex rounded-lg border overflow-hidden">
					<button
						type="button"
						onClick={() => setViewMode("form")}
						className={`px-3 py-1.5 text-sm flex items-center gap-1.5 transition-colors ${
							viewMode === "form"
								? "bg-primary text-primary-foreground"
								: "bg-secondary text-secondary-foreground hover:bg-secondary/80"
						}`}
					>
						<FormInput className="w-4 h-4" />
						Form
					</button>
					<button
						type="button"
						onClick={() => setViewMode("json")}
						className={`px-3 py-1.5 text-sm flex items-center gap-1.5 transition-colors ${
							viewMode === "json"
								? "bg-primary text-primary-foreground"
								: "bg-secondary text-secondary-foreground hover:bg-secondary/80"
						}`}
					>
						<Code className="w-4 h-4" />
						JSON
					</button>
				</div>
			</div>

			{/* Message */}
			{message && (
				<div
					className={`mb-6 p-4 rounded-lg ${
						message.type === "success"
							? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200"
							: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200"
					}`}
				>
					{message.text}
				</div>
			)}

			{viewMode === "json" ? (
				/* JSON Editor Mode */
				<div className="bg-card rounded-lg border p-6 space-y-4">
					<div>
						<label className="block text-sm font-medium mb-2">
							config.json
						</label>
						<textarea
							value={jsonText}
							onChange={(e) => {
								setJsonText(e.target.value);
								setJsonError(null);
							}}
							className="w-full h-96 px-3 py-2 rounded-lg border bg-input font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
							spellCheck={false}
						/>
						{jsonError && <p className="mt-2 text-sm text-destructive">{jsonError}</p>}
					</div>

					{/* Save Button */}
					<div className="pt-4 border-t">
						<Button onClick={handleSave} disabled={saving}>
							<Check className="w-4 h-4 mr-2" />
							{saving ? "Saving..." : "Save Configuration"}
						</Button>
					</div>
				</div>
			) : (
				/* Form Mode */
				<div className="bg-card rounded-lg border p-6 space-y-6">
					{/* Project Name */}
					<div>
						<label className="block text-sm font-medium mb-2">Project Name</label>
						<Input
							type="text"
							value={config.name || ""}
							onChange={(e) => setConfig({ ...config, name: e.target.value })}
							placeholder="My Project"
						/>
						<p className="mt-1 text-xs text-muted-foreground">Name of your project</p>
					</div>

					{/* Default Assignee */}
					<div>
						<label className="block text-sm font-medium mb-2">Default Assignee</label>
						<Input
							type="text"
							value={config.defaultAssignee || ""}
							onChange={(e) => setConfig({ ...config, defaultAssignee: e.target.value })}
							placeholder="@username"
						/>
						<p className="mt-1 text-xs text-muted-foreground">Default assignee for new tasks (e.g., @claude)</p>
					</div>

					{/* Default Priority */}
					<div>
						<label className="block text-sm font-medium mb-2">Default Priority</label>
						<select
							value={config.defaultPriority || "medium"}
							onChange={(e) =>
								setConfig({
									...config,
									defaultPriority: e.target.value as "low" | "medium" | "high",
								})
							}
							className="w-full px-3 py-2 rounded-lg border bg-input focus:outline-none focus:ring-2 focus:ring-ring"
						>
							<option value="low">Low</option>
							<option value="medium">Medium</option>
							<option value="high">High</option>
						</select>
						<p className="mt-1 text-xs text-muted-foreground">Default priority for new tasks</p>
					</div>

					{/* Default Labels */}
					<div>
						<label className="block text-sm font-medium mb-2">Default Labels</label>
						<Input
							type="text"
							value={config.defaultLabels?.join(", ") || ""}
							onChange={(e) =>
								setConfig({
									...config,
									defaultLabels: e.target.value
										.split(",")
										.map((l) => l.trim())
										.filter(Boolean),
								})
							}
							placeholder="frontend, backend, ui"
						/>
						<p className="mt-1 text-xs text-muted-foreground">Comma-separated list of default labels for new tasks</p>
					</div>

					{/* Time Format */}
					<div>
						<label className="block text-sm font-medium mb-2">Time Format</label>
						<select
							value={config.timeFormat || "24h"}
							onChange={(e) => setConfig({ ...config, timeFormat: e.target.value as "12h" | "24h" })}
							className="w-full px-3 py-2 rounded-lg border bg-input focus:outline-none focus:ring-2 focus:ring-ring"
						>
							<option value="12h">12-hour (AM/PM)</option>
							<option value="24h">24-hour</option>
						</select>
						<p className="mt-1 text-xs text-muted-foreground">Time display format</p>
					</div>

					{/* Editor */}
					<div>
						<label className="block text-sm font-medium mb-2">Default Editor</label>
						<Input
							type="text"
							value={config.editor || ""}
							onChange={(e) => setConfig({ ...config, editor: e.target.value })}
							placeholder="code, vim, nano"
						/>
						<p className="mt-1 text-xs text-muted-foreground">Default editor command for editing files</p>
					</div>

					{/* Statuses */}
					<div>
						<label className="block text-sm font-medium mb-2">Task Statuses</label>
						<div className="space-y-2 mb-3">
							{statuses.map((status) => (
								<div
									key={status}
									className="flex items-center gap-3 p-2 rounded-lg bg-accent"
								>
									<span className="flex-1 font-mono text-sm">{status}</span>
									<select
										value={statusColors[status] || "gray"}
										onChange={(e) => handleStatusColorChange(status, e.target.value)}
										className="px-2 py-1 rounded border bg-input text-sm focus:outline-none focus:ring-2 focus:ring-ring"
									>
										{COLOR_OPTIONS.map((color) => (
											<option key={color} value={color}>
												{color}
											</option>
										))}
									</select>
									<button
										type="button"
										onClick={() => handleRemoveStatus(status)}
										className="p-1 text-destructive hover:text-destructive hover:bg-destructive/10 rounded transition-colors"
										title="Remove status"
									>
										<Trash2 className="w-4 h-4" />
									</button>
								</div>
							))}
						</div>
						<div className="flex gap-2">
							<Input
								type="text"
								value={newStatus}
								onChange={(e) => setNewStatus(e.target.value)}
								placeholder="new-status"
								className="flex-1"
								onKeyDown={(e) => e.key === "Enter" && handleAddStatus()}
							/>
							<Button
								onClick={handleAddStatus}
								className="bg-green-600 hover:bg-green-700"
							>
								<Plus className="w-4 h-4 mr-2" />
								Add
							</Button>
						</div>
						<p className="mt-2 text-xs text-muted-foreground">
							Define custom task statuses and their colors for the Kanban board
						</p>
					</div>

					{/* Visible Kanban Columns */}
					<div>
						<label className="block text-sm font-medium mb-2">Visible Kanban Columns</label>
						<div className="space-y-2">
							{statuses.map((column) => {
								const isVisible = config.visibleColumns?.includes(column) ?? true;
								const label = column
									.split("-")
									.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
									.join(" ");

								return (
									<label
										key={column}
										className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
									>
										<input
											type="checkbox"
											checked={isVisible}
											onChange={(e) => {
												const current = config.visibleColumns || statuses;
												const updated = e.target.checked
													? [...current, column]
													: current.filter((c) => c !== column);
												setConfig({ ...config, visibleColumns: updated });
											}}
											className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
										/>
										<span>{label}</span>
									</label>
								);
							})}
						</div>
						<p className="mt-2 text-xs text-muted-foreground">Select which columns to show in the Kanban board</p>
					</div>

					{/* Save Button */}
					<div className="pt-4 border-t">
						<Button onClick={handleSave} disabled={saving}>
							<Check className="w-4 h-4 mr-2" />
							{saving ? "Saving..." : "Save Configuration"}
						</Button>
					</div>
				</div>
			)}
		</div>
		</ScrollArea>
	);
}
