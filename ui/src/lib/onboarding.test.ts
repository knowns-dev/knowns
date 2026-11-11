import { describe, expect, test } from "bun:test";
import { onboardingSteps } from "./onboarding";

const done = (facts: Parameters<typeof onboardingSteps>[0]) => onboardingSteps(facts, () => {}).map((s) => !!s.done);

describe("onboardingSteps", () => {
	test("a new project has nothing ticked", () => {
		expect(done({ tasks: 0, docs: 0, agentSeen: false, semanticSearch: false })).toEqual([false, false, false, false]);
	});
	test("steps tick from project state", () => {
		expect(done({ tasks: 2, docs: 0, agentSeen: true, semanticSearch: false })).toEqual([true, false, true, false]);
		expect(done({ tasks: 1, docs: 1, agentSeen: true, semanticSearch: true })).toEqual([true, true, true, true]);
	});
});
