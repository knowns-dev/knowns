import { LspSettings } from "./LspSettings";
import { SemanticSearchSettings } from "./SemanticSearchSettings";
import type { ConfigDraft } from "./useConfigDraft";

export function SearchCodeSection({ draft }: { draft: ConfigDraft }) {
	return (
		<>
			<SemanticSearchSettings draft={draft} />
			<LspSettings draft={draft} />
		</>
	);
}
