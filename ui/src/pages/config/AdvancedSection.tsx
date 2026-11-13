import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/ui/components/ui/knowns/button";
import { Select } from "@/ui/components/ui/knowns/select";
import { Switch } from "@/ui/components/ui/knowns/switch";
import { Textarea } from "@/ui/components/ui/knowns/textarea";
import { SettingsRow, SettingsSection } from "@/ui/components/ui/knowns/blocks/settings/settings-layout";
import { toast } from "@/ui/components/ui/sonner";
import DecisionMigrationTool from "@/ui/components/organisms/DecisionMigrationTool";
import { editableConfig, type ConfigDraft } from "./useConfigDraft";
import type { Config } from "@/ui/contexts/ConfigContext";

const GIT_TRACKING_OPTIONS = [
	{ value: "git-tracked", label: "Git tracked" },
	{ value: "git-ignored", label: "Git ignored" },
	{ value: "none", label: "None" },
];

const PLATFORM_OPTIONS = [
	{ id: "claude-code", label: "Claude Code" },
	{ id: "opencode", label: "OpenCode" },
	{ id: "gemini", label: "Gemini" },
	{ id: "copilot", label: "Copilot" },
	{ id: "agents", label: "Agents" },
];

export function AdvancedSection({ draft }: { draft: ConfigDraft }) {
	const { config, update, updateConfig, setConfig } = draft;
	const [jsonText, setJsonText] = useState("");
	const [jsonError, setJsonError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	// The editor follows the saved config until the user starts typing in it.
	const [dirty, setDirty] = useState(false);
	useEffect(() => {
		if (!dirty) setJsonText(JSON.stringify(editableConfig(config), null, 2));
	}, [config, dirty]);

	const saveJson = async () => {
		setSaving(true);
		try {
			const parsed = editableConfig(JSON.parse(jsonText) as Config);
			setConfig((current) => ({ ...current, ...parsed }));
			setJsonText(JSON.stringify(parsed, null, 2));
			setJsonError(null);
			await updateConfig(parsed);
			setDirty(false);
			toast.success("Saved", { duration: 1500, position: "bottom-right" });
		} catch (e) {
			if (e instanceof SyntaxError) setJsonError("Invalid JSON syntax");
			else toast.error(e instanceof Error ? e.message : "Failed to save");
		} finally {
			setSaving(false);
		}
	};

	return (
		<>
			<SettingsSection id="settings-git" title="Git tracking" description="How the .knowns directory interacts with git">
				<SettingsRow label="Mode" htmlFor="settings-git-mode">
					<Select
						id="settings-git-mode"
						className="sm:w-60"
						value={config.gitTrackingMode || "none"}
						onChange={(e) => update({ gitTrackingMode: e.target.value })}
						options={GIT_TRACKING_OPTIONS}
					/>
				</SettingsRow>
			</SettingsSection>

			<SettingsSection id="settings-platforms" title="Platforms" description="The AI platforms Knowns keeps instructions and skills for">
				{PLATFORM_OPTIONS.map((platform) => (
					<SettingsRow key={platform.id} label={platform.label}>
						<Switch
							aria-label={`${platform.label} platform`}
							checked={(config.platforms || []).includes(platform.id)}
							onCheckedChange={(checked) => {
								const current = config.platforms || [];
								update({ platforms: checked ? [...current, platform.id] : current.filter((p) => p !== platform.id) });
							}}
						/>
					</SettingsRow>
				))}
			</SettingsSection>

			<SettingsSection
				id="settings-decisions"
				title="Decision migration"
				description="An explicit maintenance workflow, kept outside normal product flows"
			>
				<DecisionMigrationTool />
			</SettingsSection>

			<SettingsSection
				id="settings-json"
				title="config.json"
				description="The raw project config. Everything here, including keys with no control in Settings, is editable; Save writes the whole file."
				footer={
					<>
						<span>Keys not shown elsewhere stay valid: set them here or with knowns config set.</span>
						<Button size="sm" icon={<Check />} onClick={() => void saveJson()} loading={saving}>
							Save
						</Button>
					</>
				}
			>
				<Textarea
					aria-label="config.json"
					aria-invalid={jsonError ? true : undefined}
					minRows={14}
					maxRows={28}
					autosize
					className="font-mono"
					spellCheck={false}
					value={jsonText}
					onChange={(e) => {
						setJsonText(e.target.value);
						setJsonError(null);
						setDirty(true);
					}}
				/>
				{jsonError && <p role="alert" className="mt-2 text-sm text-destructive">{jsonError}</p>}
			</SettingsSection>
		</>
	);
}
