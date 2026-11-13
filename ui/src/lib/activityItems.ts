import type { Activity } from "@/ui/api/client";
import type { ActivityItem } from "@/ui/components/ui/knowns/blocks/application/activity-feed";
import type { NotificationItem } from "@/ui/components/ui/knowns/blocks/application/notification-center";

/** The activity types the API filters by, in tab order. */
export type ActivityKind = "status" | "assignee" | "content";

const AGENT_LABELS: Record<string, string> = {
	"claude-code": "Claude Code",
	claude: "Claude",
	codex: "Codex",
	cursor: "Cursor",
	"gemini-cli": "Gemini CLI",
	opencode: "OpenCode",
	windsurf: "Windsurf",
	cline: "Cline",
	"roo-code": "Roo Code",
	copilot: "Copilot",
	zed: "Zed",
	kiro: "Kiro",
	amp: "Amp",
	pi: "Pi",
};

const titleCase = (slug: string) =>
	slug
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");

/**
 * Who did it. History records the actor in `author`; an MCP agent writes "mcp:<client>" (KN-4FQN0P), so
 * that is an agent named after its client. Anything else is a person, and a missing author is "Someone".
 */
export function activityActor(author?: string): { name: string; agent: boolean } {
	const value = (author ?? "").trim();
	if (!value) return { name: "Someone", agent: false };
	if (value.startsWith("mcp:")) {
		const slug = value.slice(4).trim();
		return { name: slug ? (AGENT_LABELS[slug] ?? titleCase(slug)) : "An agent", agent: true };
	}
	if (value === "mcp") return { name: "An agent", agent: true };
	return { name: value, agent: false };
}

/** What changed, as a verb phrase that ends where the task name begins. */
export function activitySummary(activity: Pick<Activity, "changes">): string {
	const changes = activity.changes ?? [];
	if (changes.length === 0) return "updated";
	const status = changes.find((c) => c.field === "status");
	if (status) {
		const next = String(status.newValue);
		if (next === "done") return "completed";
		if (next === "in-progress") return "started working on";
		if (next === "in-review") return "submitted for review";
		if (next === "blocked") return "blocked";
		return `moved to ${next}`;
	}
	const assignee = changes.find((c) => c.field === "assignee");
	if (assignee) return assignee.newValue ? `assigned to ${assignee.newValue}` : "unassigned";
	if (changes.some((c) => c.field === "title")) return "renamed";
	const priority = changes.find((c) => c.field === "priority");
	if (priority) return `set priority to ${priority.newValue} on`;
	if (changes.some((c) => c.field === "description")) return "updated the description of";
	if (changes.some((c) => c.field === "acceptanceCriteria")) return "updated the criteria of";
	if (changes.some((c) => c.field === "implementationPlan")) return "updated the plan of";
	if (changes.some((c) => c.field === "implementationNotes")) return "updated the notes of";
	if (changes.some((c) => c.field === "labels")) return "updated the labels of";
	return `updated ${changes.length} field${changes.length === 1 ? "" : "s"} on`;
}

/** Which tab an activity sits under: status moves, assignment, or everything else. */
export function activityKind(activity: Pick<Activity, "changes">): ActivityKind {
	const fields = (activity.changes ?? []).map((c) => String(c.field));
	if (fields.includes("status")) return "status";
	if (fields.includes("assignee")) return "assignee";
	return "content";
}

export const activityId = (activity: Pick<Activity, "taskId" | "version">) => `${activity.taskId}:${activity.version}`;

const show = (value: unknown) => (value === null || value === undefined || value === "" ? "none" : String(value));

/** One line of context: the first field that changed, old to new. */
function activitySnippet(activity: Pick<Activity, "changes">): string | undefined {
	const change = (activity.changes ?? [])[0];
	if (!change) return undefined;
	const field = String(change.field);
	if (["status", "assignee", "priority"].includes(field)) return `${field}: ${show(change.oldValue)} to ${show(change.newValue)}`;
	return `Changed ${field}`;
}

export function toActivityItem(activity: Activity, isUnread: (id: string, at: number) => boolean): ActivityItem {
	const id = activityId(activity);
	const at = activity.timestamp.getTime();
	return {
		id,
		at,
		type: activityKind(activity),
		actor: activityActor(activity.author),
		verb: activitySummary(activity),
		object: `#${activity.taskId} ${activity.taskTitle}`.trim(),
		snippet: activitySnippet(activity),
		unread: isUnread(id, at),
	};
}

export function toNotificationItem(activity: Activity, isUnread: (id: string, at: number) => boolean): NotificationItem {
	const id = activityId(activity);
	const at = activity.timestamp.getTime();
	const actor = activityActor(activity.author);
	return {
		id,
		at,
		type: actor.agent ? "agent" : "update",
		read: !isUnread(id, at),
		title: `${actor.name} ${activitySummary(activity)} #${activity.taskId}`,
		body: activity.taskTitle || undefined,
		actor,
	};
}
