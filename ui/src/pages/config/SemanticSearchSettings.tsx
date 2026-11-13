import { useCallback, useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/ui/components/ui/knowns/button";
import { Input } from "@/ui/components/ui/knowns/input";
import { Select } from "@/ui/components/ui/knowns/select";
import { Switch } from "@/ui/components/ui/knowns/switch";
import { SettingsRow, SettingsSection } from "@/ui/components/ui/knowns/blocks/settings/settings-layout";
import { toast } from "@/ui/components/ui/sonner";
import {
	getEmbeddingModels,
	testEmbeddingModel,
	type EmbeddingModelInfo,
	type EmbeddingModelsResponse,
	type EmbeddingModelTestResult,
} from "@/ui/api/client";
import { effectiveSemanticProvider, type ConfigDraft } from "./useConfigDraft";

const PROVIDER_OPTIONS = [
	{ value: "ollama", label: "Ollama" },
	{ value: "api", label: "API (OpenAI-compatible)" },
];

export function SemanticSearchSettings({ draft }: { draft: ConfigDraft }) {
	const { config, setConfig, update, autoSave, initialized } = draft;
	const provider = effectiveSemanticProvider(config);
	const semantic = config.semanticSearch;

	const [models, setModels] = useState<EmbeddingModelsResponse | null>(null);
	const [modelsLoading, setModelsLoading] = useState(true);
	const [apiBase, setApiBase] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [testModelName, setTestModelName] = useState("");
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<EmbeddingModelTestResult | null>(null);

	const loadModels = useCallback(async () => {
		try {
			setModelsLoading(true);
			setModels(await getEmbeddingModels());
		} catch (err) {
			console.error("Failed to load embedding models:", err);
		} finally {
			setModelsLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadModels();
	}, [loadModels]);

	useEffect(() => {
		if (!initialized || provider !== "api") return;
		setApiBase((current) => current || "http://localhost:11434/v1");
		setTestModelName((current) => current || semantic?.model || "");
	}, [initialized, provider, semantic?.model]);

	const selectModel = (model: EmbeddingModelInfo) => {
		const patch = {
			semanticSearch: {
				...(semantic || {}),
				provider,
				model: model.name,
				dimensions: model.dimensions || semantic?.dimensions || 384,
			},
		};
		setConfig((prev) => ({ ...prev, ...patch }));
		autoSave(patch);
	};

	const runTest = async () => {
		if (!apiBase.trim() || !testModelName.trim()) return;
		setTesting(true);
		setTestResult(null);
		try {
			const data = await testEmbeddingModel({ apiBase: apiBase.trim(), apiKey: apiKey.trim(), model: testModelName.trim() });
			setTestResult(data);
			if (data.success) {
				update({
					semanticSearch: { ...(semantic || {}), provider: "api", model: testModelName.trim(), dimensions: data.dimensions },
				});
				toast.success(`Model works! ${data.dimensions} dimensions detected.`);
			}
		} catch (err) {
			setTestResult({ success: false, error: err instanceof Error ? err.message : "Request failed" });
		} finally {
			setTesting(false);
		}
	};

	const list = provider === "ollama" ? models?.api || [] : models?.configured || [];

	return (
		<SettingsSection
			id="settings-search"
			title="Semantic search"
			description="Embedding model and provider for semantic search"
		>
			<SettingsRow label="Enabled" description="Search by meaning, not only by words">
				<Switch
					aria-label="Enable semantic search"
					checked={semantic?.enabled ?? false}
					onCheckedChange={(checked) => update({ semanticSearch: { ...(semantic || {}), enabled: checked, provider } })}
				/>
			</SettingsRow>
			<SettingsRow label="Provider" description="Ollama is a local server, API is a custom endpoint" htmlFor="settings-provider">
				<Select
					id="settings-provider"
					className="sm:w-60"
					value={provider}
					onChange={(e) => {
						update({ semanticSearch: { ...(semantic || {}), provider: e.target.value } });
						void loadModels();
					}}
					options={PROVIDER_OPTIONS}
				/>
			</SettingsRow>

			<div className="py-3">
				<div className="text-[13.5px] font-medium">Model</div>
				<p className="mt-0.5 text-[12.5px] text-muted-foreground">
					{provider === "ollama" ? "Select an Ollama embedding model" : "Select a configured API model"}
				</p>
				<div className="mt-2 flex flex-col gap-2">
					{modelsLoading ? (
						<Loader2 className="my-3 size-5 animate-spin text-muted-foreground" aria-label="Loading models" />
					) : list.length === 0 ? (
						<p className="py-2 text-[13px] text-muted-foreground">
							{provider === "ollama"
								? "No Ollama embedding models found. Ensure Ollama is running and has embedding models pulled."
								: "No configured API models. Use the endpoint below to test and add one."}
						</p>
					) : (
						list.map((model) => {
							const selected = semantic?.model === model.name;
							return (
								<button
									key={model.name}
									type="button"
									aria-pressed={selected}
									onClick={() => selectModel(model)}
									className={`flex items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-muted/50 motion-reduce:transition-none ${selected ? "ring-2 ring-primary" : ""}`}
								>
									<span className="flex-1">
										<span className="block text-[13.5px] font-medium">{model.name}</span>
										<span className="block text-xs text-muted-foreground">
											{model.dimensions}d{model.maxTokens ? `, ${model.maxTokens} tokens` : ""}
										</span>
									</span>
									{selected && <Check className="size-4 text-primary" aria-hidden />}
								</button>
							);
						})
					)}
				</div>
			</div>

			{provider === "api" && (
				<div className="mt-1 border-t pt-4">
					<div className="text-[13.5px] font-medium">API endpoint</div>
					<p className="mt-0.5 mb-3 text-[12.5px] text-muted-foreground">An OpenAI-compatible embedding endpoint. The key is only used for the test.</p>
					<SettingsRow label="Base URL" description="For example http://localhost:11434/v1" htmlFor="settings-api-base">
						<Input id="settings-api-base" className="sm:w-72" value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="http://localhost:11434/v1" />
					</SettingsRow>
					<SettingsRow label="API key" description="Optional bearer token" htmlFor="settings-api-key">
						<Input id="settings-api-key" className="sm:w-72" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Leave empty for local providers" />
					</SettingsRow>
					<SettingsRow label="Model name" description="Model to send in the request" htmlFor="settings-api-model">
						<div className="flex gap-2">
							<Input id="settings-api-model" className="sm:w-56" value={testModelName} onChange={(e) => setTestModelName(e.target.value)} placeholder="text-embedding-3-small" />
							<Button variant="secondary" onClick={() => void runTest()} loading={testing}>
								Test
							</Button>
						</div>
					</SettingsRow>
					{testResult && (
						<p role="status" className={`mt-2 rounded-lg border px-3 py-2 text-[13px] ${testResult.success ? "border-emerald-300/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-red-300/60 bg-red-500/10 text-red-700 dark:text-red-300"}`}>
							{testResult.success ? `Detected ${testResult.dimensions} dimensions` : testResult.error}
						</p>
					)}
				</div>
			)}
		</SettingsSection>
	);
}
