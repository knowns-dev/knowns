import { useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Globe, Search, Settings, SlidersHorizontal, Workflow } from "lucide-react";
import { SettingsLayout, type SettingsNavItem } from "@/ui/components/ui/knowns/blocks/settings/settings-layout";
import { AccessSection } from "./config/AccessSection";
import { AdvancedSection } from "./config/AdvancedSection";
import { GeneralSection } from "./config/GeneralSection";
import { SearchCodeSection } from "./config/SearchCodeSection";
import { useConfigDraft } from "./config/useConfigDraft";
import { WorkflowSection } from "./config/WorkflowSection";

type SectionId = "general" | "workflow" | "search-code" | "access" | "advanced";

const SECTIONS: SettingsNavItem[] = [
	{ id: "general", label: "General", icon: <Settings /> },
	{ id: "workflow", label: "Workflow", icon: <Workflow /> },
	{ id: "search-code", label: "Search & Code", icon: <Search /> },
	{ id: "access", label: "Access", icon: <Globe /> },
	{ id: "advanced", label: "Advanced", icon: <SlidersHorizontal /> },
];

/** Older deep links (/config?category=code) still land on the right section. */
const CATEGORY_ALIASES: Record<string, SectionId> = { code: "search-code" };

function sectionFromCategory(category: unknown): SectionId {
	const value = typeof category === "string" ? category : "";
	if (SECTIONS.some((section) => section.id === value)) return value as SectionId;
	return CATEGORY_ALIASES[value] ?? "general";
}

/**
 * Project settings. Every control autosaves through PATCH /api/config (see useConfigDraft); the
 * layout's Save bar is not used. Keys with no control here stay valid in config.json.
 */
export default function ConfigPage() {
	const draft = useConfigDraft();
	const category = useRouterState({ select: (state) => (state.location.search as Record<string, unknown>).category });
	const [active, setActive] = useState<SectionId>(() => sectionFromCategory(category));

	// A link to /config?category=... while Settings is already open switches the section too.
	useEffect(() => {
		setActive(sectionFromCategory(category));
	}, [category]);

	if (draft.loading) {
		return (
			<div className="flex h-64 items-center justify-center p-6">
				<div className="text-lg text-muted-foreground">Loading configuration...</div>
			</div>
		);
	}

	return (
		<div className="flex h-full min-w-0 flex-col overflow-hidden">
			<div className="mx-auto min-h-0 w-full min-w-0 max-w-5xl flex-1 overflow-y-auto px-4 py-5 sm:px-6">
				<SettingsLayout
					title="Settings"
					description={`Project ${draft.config.name || "Unknown"}. Changes save automatically.`}
					sections={SECTIONS}
					active={active}
					onActiveChange={(id) => setActive(id as SectionId)}
				>
					{active === "general" && <GeneralSection draft={draft} />}
					{active === "workflow" && <WorkflowSection draft={draft} />}
					{active === "search-code" && <SearchCodeSection draft={draft} />}
					{active === "access" && <AccessSection />}
					{active === "advanced" && <AdvancedSection draft={draft} />}
				</SettingsLayout>
			</div>
		</div>
	);
}
