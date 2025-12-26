import { useEffect, useState } from "react";
import { Settings, Check, Plus, Trash2, Code, FormInput } from "lucide-react";
import { useTheme } from "../App";
import { ScrollArea } from "../components/ui/scroll-area";
import { getConfig, saveConfig } from "../api/client";

type TaskStatus = string;

interface Config {
	name?: string;
	defaultAssignee?: string;
	defaultPriority?: "low" | "medium" | "high";
	defaultLabels?: string[];
	timeFormat?: "12h" | "24h";
	editor?: string;
	visibleColumns?: TaskStatus[];
	statuses?: string[];
	statusColors?: Record<string, string>;
}

const DEFAULT_STATUSES = ["todo", "in-progress", "in-review", "done", "blocked", "on-hold", "urgent"];
const COLOR_OPTIONS = ["gray", "blue", "green", "yellow", "red", "purple", "orange", "pink", "cyan", "indigo"];

export default function ConfigPage() {
	const { isDark } = useTheme();
	const [config, setConfig] = useState<Config>({});
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
	const [viewMode, setViewMode] = useState<"form" | "json">("form");
	const [jsonText, setJsonText] = useState("");
	const [jsonError, setJsonError] = useState<string | null>(null);
	const [newStatus, setNewStatus] = useState("");

	const bgColor = isDark ? "bg-gray-800" : "bg-white";
	const textColor = isDark ? "text-gray-200" : "text-gray-900";
	const textSecondary = isDark ? "text-gray-400" : "text-gray-600";
	const borderColor = isDark ? "border-gray-700" : "border-gray-200";
	const inputBg = isDark ? "bg-gray-700" : "bg-white";

	useEffect(() => {
		// Fetch config from API
		getConfig()
			.then((cfg) => {
				setConfig(cfg as Config);
				setJsonText(JSON.stringify(cfg, null, 2));
				setLoading(false);
			})
			.catch((err) => {
				console.error("Failed to load config:", err);
				setLoading(false);
			});
	}, []);

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

			await saveConfig(configToSave);

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
				<div className={`text-lg ${textSecondary}`}>Loading configuration...</div>
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
					<h1 className={`text-2xl font-bold ${textColor}`}>Configuration</h1>
				</div>

				{/* View Mode Toggle */}
				<div className={`flex rounded-lg border ${borderColor} overflow-hidden`}>
					<button
						type="button"
						onClick={() => setViewMode("form")}
						className={`px-3 py-1.5 text-sm flex items-center gap-1.5 transition-colors ${
							viewMode === "form"
								? "bg-blue-600 text-white"
								: `${isDark ? "bg-gray-700 text-gray-300 hover:bg-gray-600" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`
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
								? "bg-blue-600 text-white"
								: `${isDark ? "bg-gray-700 text-gray-300 hover:bg-gray-600" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`
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
							? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
							: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
					}`}
				>
					{message.text}
				</div>
			)}

			{viewMode === "json" ? (
				/* JSON Editor Mode */
				<div className={`${bgColor} rounded-lg border ${borderColor} p-6 space-y-4`}>
					<div>
						<label className={`block text-sm font-medium ${textColor} mb-2`}>
							config.json
						</label>
						<textarea
							value={jsonText}
							onChange={(e) => {
								setJsonText(e.target.value);
								setJsonError(null);
							}}
							className={`w-full h-96 px-3 py-2 rounded-lg border ${borderColor} ${inputBg} ${textColor} font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500`}
							spellCheck={false}
						/>
						{jsonError && <p className="mt-2 text-sm text-red-500">{jsonError}</p>}
					</div>

					{/* Save Button */}
					<div className="pt-4 border-t border-gray-700">
						<button
							type="button"
							onClick={handleSave}
							disabled={saving}
							className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-colors"
						>
							<Check className="w-4 h-4" />
							{saving ? "Saving..." : "Save Configuration"}
						</button>
					</div>
				</div>
			) : (
				/* Form Mode */
				<div className={`${bgColor} rounded-lg border ${borderColor} p-6 space-y-6`}>
					{/* Project Name */}
					<div>
						<label className={`block text-sm font-medium ${textColor} mb-2`}>Project Name</label>
						<input
							type="text"
							value={config.name || ""}
							onChange={(e) => setConfig({ ...config, name: e.target.value })}
							placeholder="My Project"
							className={`w-full px-3 py-2 rounded-lg border ${borderColor} ${inputBg} ${textColor} focus:outline-none focus:ring-2 focus:ring-blue-500`}
						/>
						<p className={`mt-1 text-xs ${textSecondary}`}>Name of your project</p>
					</div>

					{/* Default Assignee */}
					<div>
						<label className={`block text-sm font-medium ${textColor} mb-2`}>Default Assignee</label>
						<input
							type="text"
							value={config.defaultAssignee || ""}
							onChange={(e) => setConfig({ ...config, defaultAssignee: e.target.value })}
							placeholder="@username"
							className={`w-full px-3 py-2 rounded-lg border ${borderColor} ${inputBg} ${textColor} focus:outline-none focus:ring-2 focus:ring-blue-500`}
						/>
						<p className={`mt-1 text-xs ${textSecondary}`}>Default assignee for new tasks (e.g., @claude)</p>
					</div>

					{/* Default Priority */}
					<div>
						<label className={`block text-sm font-medium ${textColor} mb-2`}>Default Priority</label>
						<select
							value={config.defaultPriority || "medium"}
							onChange={(e) =>
								setConfig({
									...config,
									defaultPriority: e.target.value as "low" | "medium" | "high",
								})
							}
							className={`w-full px-3 py-2 rounded-lg border ${borderColor} ${inputBg} ${textColor} focus:outline-none focus:ring-2 focus:ring-blue-500`}
						>
							<option value="low">Low</option>
							<option value="medium">Medium</option>
							<option value="high">High</option>
						</select>
						<p className={`mt-1 text-xs ${textSecondary}`}>Default priority for new tasks</p>
					</div>

					{/* Default Labels */}
					<div>
						<label className={`block text-sm font-medium ${textColor} mb-2`}>Default Labels</label>
						<input
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
							className={`w-full px-3 py-2 rounded-lg border ${borderColor} ${inputBg} ${textColor} focus:outline-none focus:ring-2 focus:ring-blue-500`}
						/>
						<p className={`mt-1 text-xs ${textSecondary}`}>Comma-separated list of default labels for new tasks</p>
					</div>

					{/* Time Format */}
					<div>
						<label className={`block text-sm font-medium ${textColor} mb-2`}>Time Format</label>
						<select
							value={config.timeFormat || "24h"}
							onChange={(e) => setConfig({ ...config, timeFormat: e.target.value as "12h" | "24h" })}
							className={`w-full px-3 py-2 rounded-lg border ${borderColor} ${inputBg} ${textColor} focus:outline-none focus:ring-2 focus:ring-blue-500`}
						>
							<option value="12h">12-hour (AM/PM)</option>
							<option value="24h">24-hour</option>
						</select>
						<p className={`mt-1 text-xs ${textSecondary}`}>Time display format</p>
					</div>

					{/* Editor */}
					<div>
						<label className={`block text-sm font-medium ${textColor} mb-2`}>Default Editor</label>
						<input
							type="text"
							value={config.editor || ""}
							onChange={(e) => setConfig({ ...config, editor: e.target.value })}
							placeholder="code, vim, nano"
							className={`w-full px-3 py-2 rounded-lg border ${borderColor} ${inputBg} ${textColor} focus:outline-none focus:ring-2 focus:ring-blue-500`}
						/>
						<p className={`mt-1 text-xs ${textSecondary}`}>Default editor command for editing files</p>
					</div>

					{/* Statuses */}
					<div>
						<label className={`block text-sm font-medium ${textColor} mb-2`}>Task Statuses</label>
						<div className="space-y-2 mb-3">
							{statuses.map((status) => (
								<div
									key={status}
									className={`flex items-center gap-3 p-2 rounded-lg ${isDark ? "bg-gray-700" : "bg-gray-50"}`}
								>
									<span className={`flex-1 font-mono text-sm ${textColor}`}>{status}</span>
									<select
										value={statusColors[status] || "gray"}
										onChange={(e) => handleStatusColorChange(status, e.target.value)}
										className={`px-2 py-1 rounded border ${borderColor} ${inputBg} ${textColor} text-sm focus:outline-none focus:ring-2 focus:ring-blue-500`}
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
										className="p-1 text-red-500 hover:text-red-600 hover:bg-red-100 dark:hover:bg-red-900/30 rounded transition-colors"
										title="Remove status"
									>
										<Trash2 className="w-4 h-4" />
									</button>
								</div>
							))}
						</div>
						<div className="flex gap-2">
							<input
								type="text"
								value={newStatus}
								onChange={(e) => setNewStatus(e.target.value)}
								placeholder="new-status"
								className={`flex-1 px-3 py-2 rounded-lg border ${borderColor} ${inputBg} ${textColor} focus:outline-none focus:ring-2 focus:ring-blue-500`}
								onKeyDown={(e) => e.key === "Enter" && handleAddStatus()}
							/>
							<button
								type="button"
								onClick={handleAddStatus}
								className="px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 flex items-center gap-1 transition-colors"
							>
								<Plus className="w-4 h-4" />
								Add
							</button>
						</div>
						<p className={`mt-2 text-xs ${textSecondary}`}>
							Define custom task statuses and their colors for the Kanban board
						</p>
					</div>

					{/* Visible Kanban Columns */}
					<div>
						<label className={`block text-sm font-medium ${textColor} mb-2`}>Visible Kanban Columns</label>
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
											className="w-4 h-4 rounded border-gray-600 text-blue-600 focus:ring-blue-500 focus:ring-offset-gray-800"
										/>
										<span className={textColor}>{label}</span>
									</label>
								);
							})}
						</div>
						<p className={`mt-2 text-xs ${textSecondary}`}>Select which columns to show in the Kanban board</p>
					</div>

					{/* Save Button */}
					<div className="pt-4 border-t border-gray-700">
						<button
							type="button"
							onClick={handleSave}
							disabled={saving}
							className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-colors"
						>
							<Check className="w-4 h-4" />
							{saving ? "Saving..." : "Save Configuration"}
						</button>
					</div>
				</div>
			)}
		</div>
		</ScrollArea>
	);
}
