import { useEffect, useState } from "react";
import { useTheme } from "../App";

type TaskStatus = "todo" | "in-progress" | "in-review" | "done" | "blocked";

interface Config {
	defaultAssignee?: string;
	defaultPriority?: "low" | "medium" | "high";
	defaultLabels?: string[];
	timeFormat?: "12h" | "24h";
	editor?: string;
	visibleColumns?: TaskStatus[];
}

const Icons = {
	Settings: () => (
		<svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
			/>
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
			/>
		</svg>
	),
	Save: () => (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
		</svg>
	),
};

export default function ConfigPage() {
	const { isDark } = useTheme();
	const [config, setConfig] = useState<Config>({});
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

	const bgColor = isDark ? "bg-gray-800" : "bg-white";
	const textColor = isDark ? "text-gray-200" : "text-gray-900";
	const textSecondary = isDark ? "text-gray-400" : "text-gray-600";
	const borderColor = isDark ? "border-gray-700" : "border-gray-200";
	const inputBg = isDark ? "bg-gray-700" : "bg-white";

	useEffect(() => {
		// Fetch config from API
		fetch("http://localhost:3456/api/config")
			.then((res) => res.json())
			.then((data) => {
				setConfig(data.config || {});
				setLoading(false);
			})
			.catch((err) => {
				console.error("Failed to load config:", err);
				setLoading(false);
			});
	}, []);

	const handleSave = async () => {
		setSaving(true);
		setMessage(null);

		try {
			const response = await fetch("http://localhost:3456/api/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(config),
			});

			if (!response.ok) {
				throw new Error("Failed to save config");
			}

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

	if (loading) {
		return (
			<div className="p-6 flex items-center justify-center h-64">
				<div className={`text-lg ${textSecondary}`}>Loading configuration...</div>
			</div>
		);
	}

	return (
		<div className="p-6 max-w-3xl">
			{/* Header */}
			<div className="mb-6 flex items-center gap-3">
				<Icons.Settings />
				<h1 className={`text-2xl font-bold ${textColor}`}>Configuration</h1>
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

			{/* Config Form */}
			<div className={`${bgColor} rounded-lg border ${borderColor} p-6 space-y-6`}>
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
					<p className={`mt-1 text-xs ${textSecondary}`}>
						Default assignee for new tasks (e.g., @claude)
					</p>
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
					<p className={`mt-1 text-xs ${textSecondary}`}>
						Comma-separated list of default labels for new tasks
					</p>
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
					<p className={`mt-1 text-xs ${textSecondary}`}>
						Default editor command for editing files
					</p>
				</div>

				{/* Visible Kanban Columns */}
				<div>
					<label className={`block text-sm font-medium ${textColor} mb-2`}>
						Visible Kanban Columns
					</label>
					<div className="space-y-2">
						{(["todo", "in-progress", "in-review", "done", "blocked"] as TaskStatus[]).map(
							(column) => {
								const labels: Record<TaskStatus, string> = {
									todo: "To Do",
									"in-progress": "In Progress",
									"in-review": "In Review",
									done: "Done",
									blocked: "Blocked",
								};
								const isVisible = config.visibleColumns?.includes(column) ?? true;

								return (
									<label
										key={column}
										className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
									>
										<input
											type="checkbox"
											checked={isVisible}
											onChange={(e) => {
												const current = config.visibleColumns || ["todo", "in-progress", "done"];
												const updated = e.target.checked
													? [...current, column]
													: current.filter((c) => c !== column);
												setConfig({ ...config, visibleColumns: updated });
											}}
											className="w-4 h-4 rounded border-gray-600 text-blue-600 focus:ring-blue-500 focus:ring-offset-gray-800"
										/>
										<span className={textColor}>{labels[column]}</span>
									</label>
								);
							}
						)}
					</div>
					<p className={`mt-2 text-xs ${textSecondary}`}>
						Select which columns to show in the Kanban board
					</p>
				</div>

				{/* Save Button */}
				<div className="pt-4 border-t border-gray-700">
					<button
						type="button"
						onClick={handleSave}
						disabled={saving}
						className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-colors"
					>
						<Icons.Save />
						{saving ? "Saving..." : "Save Configuration"}
					</button>
				</div>
			</div>
		</div>
	);
}
