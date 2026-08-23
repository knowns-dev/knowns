import type { Doc } from "../../lib/utils";
import { isSpec } from "../../lib/utils";

export function DocKindBadges({ doc }: { doc: Doc }) {
	return (
		<>
			{isSpec(doc) && (
				<span className="inline-flex h-5 items-center rounded border border-blue-200 bg-blue-50 px-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-blue-700 dark:border-blue-900 dark:bg-blue-950/50 dark:text-blue-300">
					Spec
				</span>
			)}
			{doc.isImported && (
				<span className="inline-flex h-5 items-center rounded border border-violet-200 bg-violet-50 px-1.5 text-[10px] font-medium text-violet-700 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-300">
					Imported
				</span>
			)}
		</>
	);
}
