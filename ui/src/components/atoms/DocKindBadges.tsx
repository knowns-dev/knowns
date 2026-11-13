import { Badge } from "@/ui/components/ui/knowns/badge";
import type { Doc } from "../../lib/utils";
import { isSpec } from "../../lib/utils";

/** "Spec" and "Imported" marks after a doc's title, as Knowns UI badges. */
export function DocKindBadges({ doc }: { doc: Doc }) {
	return (
		<>
			{isSpec(doc) && (
				<Badge tone="info" size="sm" className="shrink-0">
					Spec
				</Badge>
			)}
			{doc.isImported && (
				<Badge tone="neutral" variant="outline" size="sm" className="shrink-0">
					Imported
				</Badge>
			)}
		</>
	);
}
