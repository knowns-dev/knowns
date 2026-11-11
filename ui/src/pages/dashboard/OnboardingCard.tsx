import { useMemo, useState } from "react";
import { OnboardingChecklist } from "@/ui/components/ui/knowns/blocks/onboarding/onboarding-checklist";
import { useActivities } from "@/ui/hooks/useActivities";
import { navigateTo } from "../../lib/navigation";
import { onboardingSteps, readDismissed, STEP_ROUTES, writeDismissed } from "../../lib/onboarding";

interface OnboardingCardProps {
	tasks: number;
	/** Null while the doc inventory is still loading: nothing shows until the facts are known. */
	docs: number | null;
	semanticSearch: boolean;
}

/** First-run checklist for the Dashboard. Per-browser: "Dismiss" is remembered, "Remind me later" lasts the page view. */
export function OnboardingCard({ tasks, docs, semanticSearch }: OnboardingCardProps) {
	const [dismissed, setDismissed] = useState(readDismissed);
	const [snoozed, setSnoozed] = useState(false);
	const { rawActivities } = useActivities(50);
	const agentSeen = rawActivities.some((a) => (a.author ?? "").startsWith("mcp:"));
	const steps = useMemo(
		() => onboardingSteps({ tasks, docs: docs ?? 0, agentSeen, semanticSearch }, (id) => navigateTo(STEP_ROUTES[id])),
		[tasks, docs, agentSeen, semanticSearch],
	);
	if (docs === null) return null;
	const allDone = steps.every((s) => s.done);
	return (
		<OnboardingChecklist
			aria-label="Get started"
			title="Get started with Knowns"
			description="Four steps to a project your agents can work in."
			steps={steps}
			dismissed={dismissed || snoozed}
			onSnooze={allDone ? undefined : () => setSnoozed(true)}
			onDismiss={() => {
				writeDismissed();
				setDismissed(true);
			}}
			completeTitle="You are all set"
			completeDescription="Your project has Tasks, docs, an agent and semantic search."
			className="mb-5"
		/>
	);
}
