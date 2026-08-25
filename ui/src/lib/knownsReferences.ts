/**
 * A Task ID may carry a configurable prefix (`settings.defaultTaskIdPrefix`), so a real
 * ID looks like `OLM-H9PKPY` — the hyphen belongs to the ID, unlike the hyphen in the
 * `@task-<id>` reference form. Anchoring both ends on an alphanumeric keeps `.`, `_` and
 * `-` inside the target while leaving sentence punctuation outside the match.
 *
 * Mirrors `isNamespacedTargetChar` in `internal/references/references.go`.
 */
export const TASK_TARGET_PATTERN = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?";

const KNOWNS_TASK_REFERENCE_REGEX = new RegExp(
	`(^|[\\s([>{'"])(@task[-/])(${TASK_TARGET_PATTERN})(?=(?:\\s+-\\s)|(?:\\s*\\()|(?:[\\s,.;:!?)]|$))`,
	"gm",
);

export function normalizeKnownsTaskReferences(input: string): string {
	return input.replace(KNOWNS_TASK_REFERENCE_REGEX, (_match, prefix: string, _label: string, taskId: string) => {
		return `${prefix}@task/${taskId}`;
	});
}
