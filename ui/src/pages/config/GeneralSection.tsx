import { useEffect, useState } from "react";
import { Input } from "@/ui/components/ui/knowns/input";
import { Select } from "@/ui/components/ui/knowns/select";
import { SettingsRow, SettingsSection } from "@/ui/components/ui/knowns/blocks/settings/settings-layout";
import { toast } from "@/ui/components/ui/sonner";
import type { ConfigDraft } from "./useConfigDraft";

const PRIORITY_OPTIONS = [
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
];

export function GeneralSection({ draft }: { draft: ConfigDraft }) {
	const { config, update } = draft;
	const [prefixDraft, setPrefixDraft] = useState(config.defaultTaskIdPrefix || "");

	// Follow the saved value (a failed save rolls the config back).
	useEffect(() => {
		setPrefixDraft(config.defaultTaskIdPrefix || "");
	}, [config.defaultTaskIdPrefix]);

	return (
		<>
			<SettingsSection id="settings-project" title="Project" description="Basic project information">
				<SettingsRow label="Project name" description="Display name for your project" htmlFor="settings-name">
					<Input
						id="settings-name"
						className="sm:w-72"
						value={config.name || ""}
						onChange={(e) => update({ name: e.target.value })}
						placeholder="My Project"
					/>
				</SettingsRow>
			</SettingsSection>

			<SettingsSection id="settings-defaults" title="Defaults" description="Default values for new tasks">
				<SettingsRow label="Assignee" description="Default assignee for new tasks" htmlFor="settings-assignee">
					<Input
						id="settings-assignee"
						className="sm:w-72"
						value={config.defaultAssignee || ""}
						onChange={(e) => update({ defaultAssignee: e.target.value })}
						placeholder="@username"
					/>
				</SettingsRow>
				<SettingsRow label="Priority" htmlFor="settings-priority">
					<Select
						id="settings-priority"
						className="sm:w-72"
						value={config.defaultPriority || "medium"}
						onChange={(e) => update({ defaultPriority: e.target.value as "low" | "medium" | "high" })}
						options={PRIORITY_OPTIONS}
					/>
				</SettingsRow>
				<SettingsRow label="Labels" description="Comma-separated" htmlFor="settings-labels">
					<Input
						id="settings-labels"
						className="sm:w-72"
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
				</SettingsRow>
				<SettingsRow label="Task ID prefix" description="Optional default for new tasks, for example KN" htmlFor="settings-prefix">
					<Input
						id="settings-prefix"
						className="sm:w-72"
						value={prefixDraft}
						onChange={(event) => setPrefixDraft(event.target.value.toUpperCase())}
						onBlur={() => {
							const normalized = prefixDraft.trim().toUpperCase();
							if (normalized && !/^[A-Z][A-Z0-9]{1,7}$/.test(normalized)) {
								toast.error("Prefix must be 2-8 letters or numbers and start with a letter");
								setPrefixDraft(config.defaultTaskIdPrefix || "");
								return;
							}
							setPrefixDraft(normalized);
							if (normalized !== (config.defaultTaskIdPrefix || "")) update({ defaultTaskIdPrefix: normalized });
						}}
						maxLength={8}
						placeholder="KN"
					/>
				</SettingsRow>
			</SettingsSection>
		</>
	);
}
