import { useCallback, useEffect, useRef, useState } from "react";
import { Code2, Plus } from "lucide-react";
import { Button } from "@/ui/components/ui/knowns/button";
import { Switch } from "@/ui/components/ui/knowns/switch";
import { Textarea } from "@/ui/components/ui/knowns/textarea";
import { SettingsRow, SettingsSection } from "@/ui/components/ui/knowns/blocks/settings/settings-layout";
import { toast } from "@/ui/components/ui/sonner";
import { lspApi, type LSPLanguageInfo } from "@/ui/api/client";
import type { ConfigDraft } from "./useConfigDraft";
import { LspLanguageRow, type LSPConfigDraft, type LSPLogKind, type LSPLogPanelState, type LspLanguageConfig } from "./LspLanguageRow";

export function LspSettings({ draft }: { draft: ConfigDraft }) {
	const { config, setConfig, update, autoSave } = draft;
	const languages = (config.lsp?.languages || {}) as Record<string, LspLanguageConfig>;
	const entries = Object.entries(languages);

	const [available, setAvailable] = useState<LSPLanguageInfo[]>([]);
	const [showAdd, setShowAdd] = useState(false);
	const [loading, setLoading] = useState<Record<string, boolean>>({});
	const [drafts, setDrafts] = useState<Record<string, LSPConfigDraft>>({});
	const [logPanels, setLogPanels] = useState<Record<string, LSPLogPanelState>>({});
	const [trace, setTrace] = useState<Record<string, boolean>>({});
	const addRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!showAdd) return;
		const handler = (e: MouseEvent) => {
			if (addRef.current && !addRef.current.contains(e.target as Node)) setShowAdd(false);
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [showAdd]);

	const refresh = useCallback(async () => {
		const data = await lspApi.getLanguages();
		const list = data.languages || [];
		setAvailable(list);
		setTrace((prev) => {
			const next = { ...prev };
			for (const lang of list) next[lang.id] = lang.traceEnabled ?? false;
			return next;
		});
		return list;
	}, []);

	useEffect(() => {
		refresh().catch(() => {});
	}, [refresh]);

	const setBusy = (key: string, value: boolean) => setLoading((prev) => ({ ...prev, [key]: value }));
	const message = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

	/** Runs one action with its busy flag, then reloads the language list. */
	const run = async (key: string, fn: () => Promise<void>, failure: string) => {
		setBusy(key, true);
		try {
			await fn();
		} catch (err) {
			toast.error(message(err, failure));
		} finally {
			await refresh().catch(() => []);
			setBusy(key, false);
		}
	};

	const saveLsp = (next: { enabled?: boolean; languages?: Record<string, LspLanguageConfig> }) => {
		autoSave({ lsp: next as NonNullable<typeof config.lsp> });
	};

	const addLanguage = (id: string) => {
		setShowAdd(false);
		return run(id, async () => {
			await lspApi.addLanguage(id);
			const next = { ...(config.lsp || {}), enabled: true, languages: { ...languages, [id]: { ...(languages[id] || {}), enabled: true } } };
			setConfig((prev) => ({ ...prev, lsp: next }));
			saveLsp(next);
			toast.success(`Added ${id} language server`);
		}, "Failed to add language");
	};

	const toggleLanguage = (id: string, enabled: boolean) =>
		run(id, async () => {
			await lspApi.toggleLanguage(id, enabled);
			if (!languages[id]) return;
			const next = { ...(config.lsp || {}), languages: { ...languages, [id]: { ...languages[id], enabled } } };
			setConfig((prev) => ({ ...prev, lsp: next }));
			saveLsp(next);
		}, "Failed to toggle language");

	const removeLanguage = (id: string) =>
		run(id, async () => {
			await lspApi.removeLanguage(id);
			const rest = { ...languages };
			delete rest[id];
			const next = { ...(config.lsp || {}), languages: rest };
			setConfig((prev) => ({ ...prev, lsp: next }));
			saveLsp(next);
			toast.success(`Removed ${id} language server`);
		}, "Failed to remove language");

	const restartLanguage = (id: string) =>
		run(`${id}:restart`, async () => {
			await lspApi.restartLanguage(id);
			toast.success(`Restarted ${id}`);
		}, "Failed to restart language server");

	const installLanguage = (id: string, action: "install" | "update") =>
		run(`${id}:${action}`, async () => {
			await lspApi.installLanguage(id, action);
			toast.success(`${action === "install" ? "Installed" : "Updated"} ${id}`);
		}, `Failed to ${action} dependency`);

	const cleanupLanguage = (id: string) =>
		run(`${id}:cleanup`, async () => {
			await lspApi.cleanupLanguage(id);
			toast.success(`Cleaned ${id} dependencies`);
		}, "Failed to cleanup dependencies");

	const loadLogs = async (id: string, kind: LSPLogKind = logPanels[id]?.kind || "runtime") => {
		setLogPanels((prev) => ({ ...prev, [id]: { ...(prev[id] || { kind, content: "" }), kind, loading: true } }));
		try {
			const data = await lspApi.getLanguageLogs(id, kind, 200);
			setLogPanels((prev) => ({ ...prev, [id]: { kind: data.kind, content: data.content, path: data.logPath, loading: false } }));
		} catch (err) {
			setLogPanels((prev) => ({ ...prev, [id]: { kind, content: message(err, "Failed to load logs"), loading: false } }));
		}
	};

	const setTraceFor = async (id: string, enabled: boolean) => {
		setBusy(`${id}:trace`, true);
		try {
			const data = await lspApi.setLanguageTrace(id, enabled);
			setTrace((prev) => ({ ...prev, [id]: data.enabled }));
			toast.success(data.enabled ? `Trace enabled for ${id}` : `Trace disabled for ${id}`);
			if (data.enabled) await loadLogs(id, "trace");
		} catch (err) {
			toast.error(message(err, "Failed to update trace"));
		} finally {
			setBusy(`${id}:trace`, false);
		}
	};

	const applyConfig = (id: string, langConfig: LspLanguageConfig, info: LSPLanguageInfo | undefined) =>
		run(`${id}:config`, async () => {
			const d = drafts[id] || {};
			const patch = {
				backend: d.backend ?? langConfig.backend ?? "auto",
				projectPath: d.projectPath ?? langConfig.projectPath ?? "",
				version: d.version ?? langConfig.version ?? info?.version ?? "",
				binary: d.binary ?? langConfig.binary ?? "",
				apply: true,
			};
			await lspApi.updateLanguageConfig(id, patch);
			const { apply: _apply, ...local } = patch;
			setConfig((prev) => ({
				...prev,
				lsp: { ...(prev.lsp || {}), enabled: true, languages: { ...(prev.lsp?.languages || {}), [id]: { ...(prev.lsp?.languages?.[id] || {}), ...local } } },
			}));
			setDrafts((prev) => ({ ...prev, [id]: {} }));
			toast.success(`Applied and restarted ${id}`);
		}, "Failed to update LSP config");

	const unconfigured = available.filter((lang) => !(lang.id in languages));
	const busyOf = (id: string) => Object.entries(loading).some(([key, value]) => value && key.startsWith(id));

	return (
		<>
			<SettingsSection
				id="settings-lsp"
				title="Language Server Protocol"
				description="Language servers give Knowns code intelligence: symbols, references and diagnostics."
				actions={
					<div className="relative" ref={addRef}>
						<Button size="sm" variant="secondary" icon={<Plus />} onClick={() => setShowAdd(!showAdd)} aria-expanded={showAdd} disabled={unconfigured.length === 0}>
							Add
						</Button>
						{showAdd && (
							<div role="group" aria-label="Available languages" className="absolute right-0 top-full z-50 mt-1 min-w-48 rounded-lg border bg-popover py-1 shadow-lg">
								{unconfigured.map((lang) => (
									<button key={lang.id} type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => void addLanguage(lang.id)}>
										<span className="flex-1 capitalize">{lang.name}</span>
										{!lang.installed && <span className="text-xs text-muted-foreground">(not installed)</span>}
									</button>
								))}
							</div>
						)}
					</div>
				}
			>
				<SettingsRow label="Enabled" description="Turns code intelligence on for this project">
					<Switch aria-label="Enable language servers" checked={config.lsp?.enabled ?? false} onCheckedChange={(checked) => update({ lsp: { ...(config.lsp || {}), enabled: checked } })} />
				</SettingsRow>

				<div className="mt-3 border-t pt-4">
					{entries.length === 0 ? (
						<div className="rounded-lg border bg-muted/20 py-6 text-center">
							<Code2 className="mx-auto size-8 text-muted-foreground" aria-hidden />
							<p className="mt-2 text-sm text-muted-foreground">No language servers configured</p>
							<p className="mt-1 text-xs text-muted-foreground">Use Add to configure a language</p>
						</div>
					) : (
						<ul className="flex flex-col gap-2" aria-label="Language servers">
							{entries.map(([id, langConfig]) => {
								const info = available.find((a) => a.id === id);
								return (
									<LspLanguageRow
										key={id}
										lang={id}
										config={langConfig}
										info={info}
										busy={busyOf(id)}
										configBusy={loading[`${id}:config`] ?? false}
										traceOn={trace[id] ?? info?.traceEnabled ?? false}
										draft={drafts[id] || {}}
										logPanel={logPanels[id]}
										onToggle={(enabled) => void toggleLanguage(id, enabled)}
										onRestart={() => void restartLanguage(id)}
										onInstall={(action) => void installLanguage(id, action)}
										onCleanup={() => void cleanupLanguage(id)}
										onRemove={() => void removeLanguage(id)}
										onLogs={(kind) => void loadLogs(id, kind)}
										onTrace={(enabled) => void setTraceFor(id, enabled)}
										onDraft={(field, value) => setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), [field]: value } }))}
										onApplyConfig={() => void applyConfig(id, langConfig, info)}
									/>
								);
							})}
						</ul>
					)}
				</div>
			</SettingsSection>

			<SettingsSection id="settings-ignore" title="Code intelligence ignore" description="Patterns to exclude from code analysis, one per line">
				<Textarea
					aria-label="Ignore patterns"
					minRows={5}
					className="font-mono"
					value={(config.codeIntelligenceIgnore || []).join("\n")}
					onChange={(e) =>
						update({
							codeIntelligenceIgnore: e.target.value
								.split("\n")
								.map((l) => l.trim())
								.filter(Boolean),
						})
					}
					placeholder={"node_modules/\ndist/\n*.test.ts\n*.spec.ts"}
				/>
			</SettingsSection>
		</>
	);
}
