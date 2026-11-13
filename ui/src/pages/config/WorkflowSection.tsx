import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/ui/components/ui/knowns/button";
import { Input } from "@/ui/components/ui/knowns/input";
import { Select } from "@/ui/components/ui/knowns/select";
import { Switch } from "@/ui/components/ui/knowns/switch";
import { SettingsRow, SettingsSection } from "@/ui/components/ui/knowns/blocks/settings/settings-layout";
import { toast } from "@/ui/components/ui/sonner";
import { getStatusLabel } from "@/ui/utils/colors";
import { DEFAULT_STATUSES, type ConfigDraft } from "./useConfigDraft";

const COLOR_OPTIONS = ["gray", "blue", "green", "yellow", "red", "purple", "orange", "pink", "cyan", "indigo"];

export function WorkflowSection({ draft }: { draft: ConfigDraft }) {
	const { config, update } = draft;
	const [newStatus, setNewStatus] = useState("");
	const statuses = config.statuses || DEFAULT_STATUSES;
	const statusColors = config.statusColors || {};

	const addStatus = () => {
		if (!newStatus.trim()) return;
		const statusKey = newStatus.toLowerCase().replace(/\s+/g, "-");
		if (statuses.includes(statusKey)) {
			toast.error("Status already exists");
			return;
		}
		update({
			statuses: [...statuses, statusKey],
			statusColors: { ...statusColors, [statusKey]: "gray" },
		});
		setNewStatus("");
	};

	const removeStatus = (status: string) => {
		const colors = { ...statusColors };
		delete colors[status];
		update({
			statuses: statuses.filter((s) => s !== status),
			statusColors: colors,
			visibleColumns: (config.visibleColumns || []).filter((c) => c !== status),
		});
	};

	const setOnBoard = (status: string, visible: boolean) => {
		const current = config.visibleColumns || statuses;
		update({ visibleColumns: visible ? [...current, status] : current.filter((c) => c !== status) });
	};

	const lifecycle = config.taskLifecycle || {
		excludeDoneFromDefaultRetrieval: true,
		autoArchive: true,
		archiveAfter: "30d",
		purgeAfter: null,
	};
	const updateLifecycle = (patch: Partial<NonNullable<typeof config.taskLifecycle>>) => update({ taskLifecycle: patch });

	return (
		<>
			<SettingsSection
				id="settings-statuses"
				title="Statuses"
				description="The statuses Tasks move through. Each has a colour and can be shown or hidden as a Board column."
			>
				<ul className="flex flex-col divide-y" aria-label="Task statuses">
					{statuses.map((status) => {
						const onBoard = config.visibleColumns?.includes(status) ?? true;
						return (
							<li key={status} className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0">
								<span className="min-w-0 flex-1 truncate font-mono text-[13px]">{status}</span>
								<Select
									size="sm"
									aria-label={`Colour for ${getStatusLabel(status)}`}
									className="w-28"
									value={statusColors[status] || "gray"}
									onChange={(e) => update({ statusColors: { ...statusColors, [status]: e.target.value } })}
									options={COLOR_OPTIONS}
								/>
								<Switch
									aria-label={`Show ${getStatusLabel(status)} on Board`}
									label="On Board"
									checked={onBoard}
									onCheckedChange={(checked) => setOnBoard(status, checked)}
								/>
								<Button
									size="sm"
									variant="ghost"
									icon={<Trash2 />}
									aria-label={`Remove status ${getStatusLabel(status)}`}
									onClick={() => removeStatus(status)}
								/>
							</li>
						);
					})}
				</ul>
				<div className="mt-4 flex gap-2 border-t pt-4">
					<Input
						size="sm"
						aria-label="New status"
						value={newStatus}
						onChange={(e) => setNewStatus(e.target.value)}
						placeholder="new-status"
						onKeyDown={(e) => e.key === "Enter" && addStatus()}
					/>
					<Button size="sm" variant="secondary" icon={<Plus />} onClick={addStatus}>
						Add
					</Button>
				</div>
			</SettingsSection>

			<SettingsSection
				id="settings-lifecycle"
				title="Task lifecycle"
				description="Keep completed and archived work out of default AI context while preserving it for explicit historical access"
				className="scroll-mt-6"
			>
				<div data-testid="task-lifecycle-settings">
					<SettingsRow label="Exclude done from AI retrieval" description="Human task views still show done Tasks by default">
						<Switch
							aria-label="Exclude done Tasks from default AI retrieval"
							checked={lifecycle.excludeDoneFromDefaultRetrieval}
							onCheckedChange={(checked) => updateLifecycle({ excludeDoneFromDefaultRetrieval: checked })}
						/>
					</SettingsRow>
					<SettingsRow label="Auto-archive" description="When disabled, completed Tasks remain in the done lifecycle state">
						<Switch
							aria-label="Enable automatic Task archival"
							checked={lifecycle.autoArchive}
							onCheckedChange={(checked) => updateLifecycle({ autoArchive: checked })}
						/>
					</SettingsRow>
					<SettingsRow
						label="Archive after"
						description="Backend duration, for example 0d, 30d, or 720h. Zero archives right after every eligibility check passes."
					>
						<Input
							className="sm:w-40"
							aria-label="Archive completed Tasks after"
							value={lifecycle.archiveAfter}
							onChange={(event) => updateLifecycle({ archiveAfter: event.target.value })}
							disabled={!lifecycle.autoArchive}
							placeholder="30d"
						/>
					</SettingsRow>
				</div>
			</SettingsSection>
		</>
	);
}
