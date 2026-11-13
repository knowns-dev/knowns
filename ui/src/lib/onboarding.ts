import type { ChecklistStep } from "@/ui/components/ui/knowns/blocks/onboarding/onboarding-checklist";

export interface ProjectFacts {
	tasks: number;
	docs: number;
	/** Some MCP agent has changed a Task (history carries author "mcp:<client>"). */
	agentSeen: boolean;
	semanticSearch: boolean;
}

export type OnboardingStepId = "task" | "doc" | "agent" | "semantic";

/** The four first-run steps. Each ticks from what the project actually contains, never from a click. */
export function onboardingSteps(facts: ProjectFacts, go: (id: OnboardingStepId) => void): ChecklistStep[] {
	const cta = (id: OnboardingStepId, label: string) => ({ label, onClick: () => go(id) });
	return [
		{
			id: "task",
			title: "Create a Task",
			description: "Tasks are the unit of work your agents and you share.",
			done: facts.tasks > 0,
			cta: cta("task", "Open Tasks"),
		},
		{
			id: "doc",
			title: "Write a doc",
			description: "Docs are the project memory agents read before they plan.",
			done: facts.docs > 0,
			cta: cta("doc", "Open Docs"),
		},
		{
			id: "agent",
			title: "Connect an agent over MCP",
			description: "Once an agent updates a Task, it shows up here.",
			done: facts.agentSeen,
			cta: cta("agent", "Open Runtime"),
			how: "Run `knowns init` in the project, then start your agent. It picks up the Knowns MCP server on its own.",
		},
		{
			id: "semantic",
			title: "Turn on semantic search",
			description: "Find docs and Tasks by meaning, not just by words.",
			done: facts.semanticSearch,
			cta: cta("semantic", "Open Settings"),
		},
	];
}

export const STEP_ROUTES: Record<OnboardingStepId, string> = {
	task: "/tasks",
	doc: "/docs",
	agent: "/runtime",
	semantic: "/config?category=search-code",
};

const DISMISS_KEY = "knowns-onboarding-dismissed-v1";

export function readDismissed(): boolean {
	try {
		return localStorage.getItem(DISMISS_KEY) === "1";
	} catch {
		return false;
	}
}

export function writeDismissed() {
	try {
		localStorage.setItem(DISMISS_KEY, "1");
	} catch {
		// Not persisted; it stays hidden for this page view.
	}
}
