const KNOWNS_TASK_REFERENCE_REGEX = /(^|[\s([>{'"])(@task[-/])([a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)?)(?=(?:\s+-\s)|(?:\s*\()|(?:[\s,.;:!?)]|$))/gm;

export function normalizeKnownsTaskReferences(input: string): string {
	return input.replace(KNOWNS_TASK_REFERENCE_REGEX, (_match, prefix: string, _label: string, taskId: string) => {
		return `${prefix}@task/${taskId}`;
	});
}
