import { test, expect, type Page } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

type DecisionSeed = {
	prefix: string;
	currentID: string;
	currentTitle: string;
	historicalID: string;
	historicalTitle: string;
	draftTitle: string;
	rejectedTitle: string;
	archivedTitle: string;
	createTargetID: string;
	createTargetTitle: string;
	selectTargetID: string;
	selectTargetTitle: string;
	selectReplacementID: string;
	selectReplacementTitle: string;
};

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Decision ledger", () => {
	test("opens to current accepted Decisions and filters historical statuses", async ({ page }) => {
		const seed = await seedDecisionLedger(page);
		await page.goto(`${server.baseURL}/decisions`);

		await expect(page.getByRole("heading", { name: "Decision ledger" })).toBeVisible();
		await expect(page.getByRole("tab", { name: /Accepted/ })).toHaveAttribute("aria-selected", "true");
		await expect(page.getByTestId("decision-list")).toContainText(seed.currentTitle);
		await expect(page.getByTestId("decision-list")).not.toContainText(seed.historicalTitle);

		await page.getByRole("tab", { name: /Draft/ }).click();
		await expect(page.getByTestId("decision-list")).toContainText(seed.draftTitle);

		await page.getByRole("tab", { name: /Superseded/ }).click();
		await expect(page.getByTestId("decision-list")).toContainText(seed.historicalTitle);

		await page.getByRole("tab", { name: /Rejected/ }).click();
		await expect(page.getByTestId("decision-list")).toContainText(seed.rejectedTitle);

		await page.getByRole("tab", { name: /Archived/ }).click();
		await expect(page.getByTestId("decision-list")).toContainText(seed.archivedTitle);

		await page.getByRole("tab", { name: /All/ }).click();
		await expect(page.getByTestId("decision-list")).toContainText(seed.currentTitle);
		await expect(page.getByTestId("decision-list")).toContainText(seed.historicalTitle);
	});

	test("shows detail metadata, body sections, and supersession links", async ({ page }) => {
		const seed = await seedDecisionLedger(page);
		await page.goto(`${server.baseURL}/decisions`);

		await page.getByTestId(`decision-row-${seed.currentID}`).click();
		const detail = page.getByTestId("decision-detail-panel");

		await expect(detail).toContainText(`@decision/${seed.currentID}`);
		await expect(detail).toContainText("Current");
		await expect(detail).toContainText("Supersedes");
		await expect(detail).toContainText(seed.historicalTitle);
		await expect(detail).toContainText("@doc/specs/vector");
		await expect(detail).toContainText("h1oeud");
		await expect(detail).toContainText("#vector");
		await expect(detail).toContainText("Context");
		await expect(detail).toContainText("Decision");
		await expect(detail).toContainText("Alternatives considered");
		await expect(detail).toContainText("Consequences");
	});

	test("creates a replacement Decision and leaves the old Decision historical", async ({ page }) => {
		const seed = await seedDecisionLedger(page);
		const replacementTitle = `Created Qdrant replacement ${seed.prefix}`;
		await page.goto(`${server.baseURL}/decisions`);

		await page.getByTestId(`decision-row-${seed.createTargetID}`).click();
		const panel = page.getByTestId("decision-supersede-panel");
		await panel.getByRole("tab", { name: "Create" }).click();
		await panel.getByLabel("Replacement title").fill(replacementTitle);
		await panel.getByLabel("Tags").fill("vector, qdrant");
		await panel.getByLabel("Sources").fill("@doc/specs/vector");
		await panel.getByLabel("Related docs").fill("specs/vector");
		await panel.getByLabel("Related tasks").fill("h1oeud");
		await panel.getByLabel("Context").fill("Chroma was replaced after evaluation.");
		await panel.getByLabel("Decision", { exact: true }).fill("Use Qdrant as the default vector database.");
		await panel.getByLabel("Alternatives considered").fill("Chroma remained available for local experiments.");
		await panel.getByLabel("Consequences").fill("Search guidance now points at Qdrant.");
		await panel.getByRole("button", { name: "Create replacement" }).click();

		const detail = page.getByTestId("decision-detail-panel");
		await expect(page.getByRole("tab", { name: /Superseded/ })).toHaveAttribute("aria-selected", "true");
		await expect(detail).toContainText(seed.createTargetTitle);
		await expect(detail).toContainText("Historical guidance");
		await expect(detail).toContainText("Superseded by");
		await expect(detail).toContainText(replacementTitle);
	});

	test("selects an existing replacement Decision and updates both sides", async ({ page }) => {
		const seed = await seedDecisionLedger(page);
		await page.goto(`${server.baseURL}/decisions`);

		await page.getByTestId(`decision-row-${seed.selectTargetID}`).click();
		const panel = page.getByTestId("decision-supersede-panel");
		await panel.getByRole("tab", { name: "Select" }).click();
		await panel.getByLabel("Replacement Decision").selectOption(seed.selectReplacementID);
		await panel.getByRole("button", { name: "Use selected" }).click();

		const detail = page.getByTestId("decision-detail-panel");
		await expect(detail).toContainText(seed.selectTargetTitle);
		await expect(detail).toContainText("Historical guidance");
		await expect(detail).toContainText(seed.selectReplacementTitle);

		await detail.getByRole("button", { name: new RegExp(seed.selectReplacementTitle) }).click();
		await expect(detail).toContainText("Supersedes");
		await expect(detail).toContainText(seed.selectTargetTitle);
	});

	test("has no horizontal overflow in desktop and mobile key viewports", async ({ page }, testInfo) => {
		await seedDecisionLedger(page);

		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto(`${server.baseURL}/decisions`);
		await expect(page.getByRole("heading", { name: "Decision ledger" })).toBeVisible();
		await expectNoHorizontalOverflow(page);
		await expectControlsFit(page);
		await page.screenshot({ path: testInfo.outputPath("decision-ledger-desktop.png"), fullPage: true });

		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(`${server.baseURL}/decisions`);
		await expect(page.getByRole("heading", { name: "Decision ledger" })).toBeVisible();
		await expect(page.getByRole("tab", { name: /Accepted/ })).toBeVisible();
		await expectNoHorizontalOverflow(page);
		await expectControlsFit(page);
		await page.screenshot({ path: testInfo.outputPath("decision-ledger-mobile.png"), fullPage: true });
	});
});

async function seedDecisionLedger(page: Page): Promise<DecisionSeed> {
	const prefix = uniqueToken("replacement");
	const vectorToken = uniqueToken("vector");
	const draftToken = uniqueToken("draft");
	const rejectedToken = uniqueToken("rejected");
	const archivedToken = uniqueToken("archived");
	const createToken = uniqueToken("create");
	const selectToken = uniqueToken("select");
	const selectedReplacementToken = uniqueToken("selected");
	const currentTitle = `Use Qdrant current ${vectorToken}`;
	const historicalTitle = `Use Chroma historical ${vectorToken}`;
	const createTargetTitle = `Legacy parser create target ${createToken}`;
	const selectTargetTitle = `Old sync queue select target ${selectToken}`;
	const selectReplacementTitle = `New scheduler selected replacement ${selectedReplacementToken}`;

	const historical = await createDecision(page, {
		title: historicalTitle,
		status: "accepted",
		tags: ["vector"],
		sources: ["@doc/specs/vector"],
		relatedDocs: ["specs/vector"],
		context: `Historical vector context for ${vectorToken}.`,
		decision: `Use Chroma for historical storage ${vectorToken}.`,
		alternativesConsidered: "Use Qdrant.",
		consequences: "This should become historical after supersession.",
	});
	const currentResult = await resolveDecisionReview(page, {
		resolution: "supersede_existing",
		targetId: historical.id,
		title: currentTitle,
		status: "accepted",
		tags: ["vector", "qdrant"],
		sources: ["@doc/specs/vector"],
		relatedDocs: ["specs/vector"],
		relatedTasks: ["h1oeud"],
		context: `Current vector context for ${vectorToken}.`,
		decision: `Use Qdrant for current production storage ${vectorToken}.`,
		alternativesConsidered: "Use Chroma.",
		consequences: "Default guidance points at Qdrant.",
	});
	const current = currentResult.current || currentResult.decision;
	expect(current, "supersede resolution should return current decision").toBeTruthy();

	const draft = await createDecision(page, {
		title: `Draft reranker ${draftToken}`,
		status: "draft",
		tags: ["search"],
		context: `Draft reranker context ${draftToken}.`,
		decision: `Evaluate rerankers before accepting ${draftToken}.`,
	});
	const rejected = await createDecision(page, {
		title: `Rejected graph store ${rejectedToken}`,
		status: "rejected",
		tags: ["graph"],
		context: `Rejected graph context ${rejectedToken}.`,
		decision: `Do not use the rejected graph store ${rejectedToken}.`,
	});
	const archived = await createDecision(page, {
		title: `Archived cache decision ${archivedToken}`,
		status: "archived",
		tags: ["cache"],
		context: `Archived cache context ${archivedToken}.`,
		decision: `Keep this cache decision archived ${archivedToken}.`,
	});
	const createTarget = await createDecision(page, {
		title: createTargetTitle,
		status: "accepted",
		tags: ["vector"],
		sources: ["@doc/specs/vector"],
		relatedDocs: ["specs/vector"],
		context: `Create target context ${createToken}.`,
		decision: `Use the legacy parser until a new replacement is created ${createToken}.`,
	});
	const selectTarget = await createDecision(page, {
		title: selectTargetTitle,
		status: "accepted",
		tags: ["vector"],
		sources: ["@doc/specs/vector"],
		relatedDocs: ["specs/vector"],
		context: `Select target context ${selectToken}.`,
		decision: `Use the old sync queue until an existing replacement is selected ${selectToken}.`,
	});
	const selectReplacement = await createDecision(page, {
		title: selectReplacementTitle,
		status: "accepted",
		tags: ["vector", "qdrant"],
		sources: ["@doc/specs/vector"],
		relatedDocs: ["specs/vector"],
		context: `Selected replacement context ${selectedReplacementToken}.`,
		decision: `Use the new scheduler as the selected replacement ${selectedReplacementToken}.`,
	});

	return {
		prefix,
		currentID: current!.id,
		currentTitle,
		historicalID: historical.id,
		historicalTitle,
		draftTitle: draft.title,
		rejectedTitle: rejected.title,
		archivedTitle: archived.title,
		createTargetID: createTarget.id,
		createTargetTitle,
		selectTargetID: selectTarget.id,
		selectTargetTitle,
		selectReplacementID: selectReplacement.id,
		selectReplacementTitle,
	};
}

function uniqueToken(label: string) {
	return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createDecision(page: Page, body: Record<string, unknown>): Promise<{ id: string; title: string }> {
	const response = await page.request.post(`${server.baseURL}/api/decisions`, { data: body });
	if (response.ok()) {
		return response.json() as Promise<{ id: string; title: string }>;
	}
	if (response.status() === 409) {
		const status = String(body.status || "");
		if (status === "accepted") {
			const resolved = await resolveDecisionReview(page, { ...body, resolution: "create_draft", status: "draft" });
			const created = resolved.decision;
			expect(created, "create_draft resolution should return a decision").toBeTruthy();
			if (hasLinkData(body)) {
				return linkDecision(page, created!.id, {
					sources: body.sources,
					relatedDocs: body.relatedDocs,
					relatedTasks: body.relatedTasks,
				});
			}
			return created!;
		}
		if (status === "draft" || status === "") {
			const resolved = await resolveDecisionReview(page, { ...body, resolution: "create_draft", status: "draft" });
			expect(resolved.decision, "create_draft resolution should return a decision").toBeTruthy();
			return resolved.decision!;
		}
		if (status === "rejected") {
			const resolved = await resolveDecisionReview(page, { ...body, resolution: "reject_new", status: "rejected" });
			expect(resolved.decision, "reject_new resolution should return a decision").toBeTruthy();
			return resolved.decision!;
		}
	}
	expect(response.ok(), `/api/decisions failed with ${response.status()}: ${await response.text()}`).toBeTruthy();
	return response.json() as Promise<{ id: string; title: string }>;
}

async function resolveDecisionReview(
	page: Page,
	body: Record<string, unknown>,
): Promise<{ decision?: { id: string; title: string }; current?: { id: string; title: string } }> {
	return postJSON(page, "/api/decisions/review/resolve", body);
}

async function linkDecision(page: Page, id: string, body: Record<string, unknown>): Promise<{ id: string; title: string }> {
	return postJSON(page, `/api/decisions/${id}/link`, body);
}

function hasLinkData(body: Record<string, unknown>) {
	return ["sources", "relatedDocs", "relatedTasks"].some((key) => {
		const value = body[key];
		return Array.isArray(value) && value.length > 0;
	});
}

async function postJSON<T = unknown>(page: Page, path: string, body: Record<string, unknown>): Promise<T> {
	const response = await page.request.post(`${server.baseURL}${path}`, { data: body });
	expect(response.ok(), `${path} failed with ${response.status()}: ${await response.text()}`).toBeTruthy();
	return response.json() as Promise<T>;
}

async function expectNoHorizontalOverflow(page: Page) {
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	expect(overflow).toBeLessThanOrEqual(1);
}

async function expectControlsFit(page: Page) {
	const overflowing = await page.locator('[role="tab"], [data-testid="decision-supersede-panel"] button').evaluateAll((elements) =>
		elements
			.filter((element) => {
				const rect = element.getBoundingClientRect();
				return rect.width > 0 && element.scrollWidth > element.clientWidth + 1;
			})
			.map((element) => element.textContent?.trim() || element.getAttribute("aria-label") || "control"),
	);
	expect(overflowing).toEqual([]);
}
