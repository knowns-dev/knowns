import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

type DecisionSeed = {
	currentID: string;
	currentTitle: string;
	historicalTitle: string;
	rejectedTitle: string;
	archivedTitle: string;
	evidenceDoc: string;
	evidenceTask: string;
};

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Decision processing flow", () => {
	test("opens to read-only Current and keeps History separate", async ({ page }) => {
		const seed = await seedDecisionLedger(page);
		await page.goto(`${server.baseURL}/decisions`);

		await expect(page.getByRole("heading", { name: "System Decisions" })).toBeVisible();
		await expect(page.getByRole("tab", { name: /Current/ })).toHaveAttribute("aria-selected", "true");
		await expect(page.getByTestId("decision-list")).toContainText(seed.currentTitle);
		await expect(page.getByTestId("decision-list")).not.toContainText(seed.historicalTitle);
		await expect(page.getByRole("button", { name: "New candidate" })).toBeHidden();
		await expect(page.getByRole("button", { name: /migration/i })).toBeHidden();

		await page.getByTestId(`decision-row-${seed.currentID}`).click();
		const detail = page.getByTestId("decision-detail-panel");
		await expect(detail).toContainText("Read-only current guidance");
		await expect(detail).toContainText(`@decision/${seed.currentID}`);
		await expect(detail).toContainText(seed.historicalTitle);
		await expect(detail).toContainText(`@doc/${seed.evidenceDoc}`);
		await expect(detail).toContainText(seed.evidenceTask);
		await expect(detail.getByRole("button", { name: /accept|replace|reject/i })).toHaveCount(0);
		await detail.getByRole("button", { name: `Supersedes: ${seed.historicalTitle}` }).click();
		await expect(detail).toContainText("Read-only history");
		await detail.getByRole("button", { name: `Superseded by: ${seed.currentTitle}` }).click();
		await expect(detail).toContainText("Read-only current guidance");
		await page.getByTestId("decision-mobile-back").click();

		await page.getByRole("tab", { name: /History/ }).click();
		await expect(page).toHaveURL(/\/decisions\/history$/);
		await expect(page.getByTestId("decision-list")).toContainText(seed.historicalTitle);
		await expect(page.getByTestId("decision-list")).toContainText(seed.rejectedTitle);
		await expect(page.getByTestId("decision-list")).toContainText(seed.archivedTitle);
		await expect(page.getByTestId("decision-list")).not.toContainText(seed.currentTitle);
	});

	test("persists manual creation in Review Inbox and exposes only valid actions", async ({ page }) => {
		const seed = await seedDecisionLedger(page);
		await page.goto(`${server.baseURL}/decisions/review`);

		await expect(page.getByRole("tab", { name: /Review Inbox/ })).toHaveAttribute("aria-selected", "true");
		await page.getByRole("button", { name: "New candidate" }).click();
		const create = page.getByTestId("decision-create-panel");
		await create.getByLabel("Title").fill(seed.currentTitle);
		await create.getByLabel("Sources").fill(`@doc/${seed.evidenceDoc}`);
		await create.getByLabel("Related docs").fill(seed.evidenceDoc);
		await create.getByLabel("Completed tasks").fill(seed.evidenceTask);
		await create.getByLabel("Decision", { exact: true }).fill("Replace matching current guidance after explicit review.");
		await create.getByRole("button", { name: "Save to Review Inbox" }).click();

		await expect(create).toBeHidden();
		await expect(page.getByText(/Candidate saved to Review Inbox as Needs resolution/)).toBeVisible();
		const candidateRow = page
			.getByTestId("decision-list")
			.getByRole("button", { name: new RegExp(escapeRegExp(seed.currentTitle)) })
			.first();
		await expect(candidateRow).toContainText("Needs resolution");
		await candidateRow.click();

		const review = page.getByTestId("decision-review-detail");
		await expect(review).toContainText("Persisted candidate");
		await expect(review).toContainText("Needs resolution");
		await expect(review.getByRole("button", { name: "Review acceptance" })).toBeHidden();
		await expect(review.getByRole("button", { name: "Link to current" }).first()).toBeVisible();
		await expect(review.getByRole("button", { name: "Replace current" }).first()).toBeVisible();
		await review.getByRole("button", { name: "Replace current" }).first().click();

		const confirmation = page.getByTestId("decision-action-confirmation");
		await expect(confirmation).toContainText("Target");
		await expect(confirmation).toContainText("Evidence outcome");
		await expect(confirmation).toContainText("Resulting lifecycle");
		await expect(confirmation).toContainText(seed.currentTitle);
		await confirmation.getByRole("button", { name: "Cancel" }).click();
		await expect(confirmation).toBeHidden();
	});

	test("uses modal-level source selection and re-evaluates Needs evidence", async ({ page }, testInfo) => {
		const seed = await seedDecisionLedger(page);
		const candidateTitle = `Evidence candidate ${uniqueToken("review")}`;
		await page.goto(`${server.baseURL}/decisions/review`);

		await page.getByRole("button", { name: "New candidate" }).click();
		const create = page.getByTestId("decision-create-panel");
		await create.getByLabel("Title").fill(candidateTitle);
		await create.getByLabel("Decision", { exact: true }).fill("Adopt a uniquely identified reviewed behavior.");
		await create.getByRole("button", { name: "Save to Review Inbox" }).click();
		await expect(page.getByText(/Candidate saved to Review Inbox as Needs evidence/)).toBeVisible();
		await page
			.getByTestId("decision-list")
			.getByRole("button", { name: new RegExp(escapeRegExp(candidateTitle)) })
			.click();

		const review = page.getByTestId("decision-review-detail");
		await expect(review).toContainText("Needs evidence");
		const sources = review.getByLabel("Sources");
		await sources.fill("https://example.test/external-evidence");
		await review.getByRole("button", { name: "Browse existing" }).first().click();
		const browser = page.getByTestId("reference-browser");
		const browserZIndex = await browser.evaluate((element) => Number.parseInt(window.getComputedStyle(element).zIndex, 10));
		const detailZIndex = await page
			.getByTestId("decision-focus-dialog")
			.evaluate((element) => Number.parseInt(window.getComputedStyle(element).zIndex, 10));
		expect(browserZIndex).toBeGreaterThan(detailZIndex);
		const search = browser.getByPlaceholder("Search by title, path, or ID…");
		await search.fill(seed.evidenceDoc);
		await browser.getByRole("button", { name: /Add Doc:/ }).first().click();
		await expect(sources).toHaveValue(new RegExp(`@doc/${escapeRegExp(seed.evidenceDoc)}`));
		await page.keyboard.press("Escape");

		await review.getByLabel("Related docs").fill(seed.evidenceDoc);
		await review.getByLabel("Completed tasks").fill(seed.evidenceTask);
		await review.getByRole("button", { name: "Review evidence update" }).click();
		const confirmation = page.getByTestId("decision-action-confirmation");
		await expect(confirmation).toContainText("The candidate is re-evaluated");
		await confirmation.getByRole("button", { name: "Confirm evidence" }).click();
		await expect(page.getByText(/Evidence reviewed. Candidate is now Ready for review/)).toBeVisible();
		await expect(review).toContainText("Ready for review");
		await review.getByRole("button", { name: "Review acceptance" }).click();
		await expect(page.getByTestId("decision-action-confirmation")).toContainText(
			"Candidate becomes accepted and enters Current guidance",
		);
		await page.getByTestId("decision-action-confirmation").getByRole("button", { name: "Cancel" }).click();
		await page.screenshot({ path: testInfo.outputPath("decision-review-ready.png"), fullPage: true });
	});

	test("keeps Legacy Decision Memory migration under Settings > Tools", async ({ page }) => {
		const memoryID = "leg001";
		const title = `Legacy migration ${uniqueToken("memory")}`;
		seedLegacyDecisionMemory(memoryID, title);
		await page.goto(`${server.baseURL}/decisions/review`);
		await expect(page.getByText("Legacy Decision Memory migration")).toBeHidden();

		await page.goto(`${server.baseURL}/config`);
		await page.getByRole("button", { name: "Tools" }).click();
		await expect(page.getByRole("heading", { name: "Legacy Decision Memory migration" })).toBeVisible();
		await page.getByRole("button", { name: "Open migration workspace" }).click();
		const migration = page.getByTestId("decision-migration-panel");
		await expect(migration).toContainText("Preview is read-only");
		const row = page.getByTestId(`decision-migration-row-${memoryID}`);
		await expect(row).toContainText(title);
		await row.getByLabel("Reviewed resolution").selectOption("leave_unchanged");
		await row.getByRole("button", { name: "Review apply" }).click();
		const confirmation = page.getByTestId(`decision-migration-confirm-${memoryID}`);
		await expect(confirmation).toContainText("Only this reviewed row is applied");
		await confirmation.getByRole("button", { name: "Cancel" }).click();
	});

	test("keeps destinations and focus dialogs reachable on mobile", async ({ page }, testInfo) => {
		const seed = await seedDecisionLedger(page);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(`${server.baseURL}/decisions`);

		await expect(page.getByRole("tab", { name: /Current/ })).toBeVisible();
		await expect(page.getByRole("tab", { name: /Review Inbox/ })).toBeVisible();
		await expect(page.getByRole("tab", { name: /History/ })).toBeVisible();
		const row = page.getByTestId(`decision-row-${seed.currentID}`);
		await row.click();
		const detail = page.getByTestId("decision-focus-dialog");
		await expect(detail).toBeVisible();
		const back = page.getByTestId("decision-mobile-back");
		const backBox = await back.boundingBox();
		expect(backBox?.height || 0).toBeGreaterThanOrEqual(44);
		await back.click();
		await expect(row).toBeFocused();

		await page.getByRole("tab", { name: /Review Inbox/ }).click();
		await page.getByRole("button", { name: "New candidate" }).click();
		const create = page.getByTestId("decision-create-panel");
		await create.getByRole("button", { name: "Browse existing" }).first().click();
		const picker = page.getByTestId("reference-browser");
		const pickerBox = await picker.boundingBox();
		expect(pickerBox?.x || 0).toBeGreaterThanOrEqual(0);
		expect(pickerBox?.y || 0).toBeGreaterThanOrEqual(0);
		expect((pickerBox?.x || 0) + (pickerBox?.width || 0)).toBeLessThanOrEqual(390);
		expect((pickerBox?.y || 0) + (pickerBox?.height || 0)).toBeLessThanOrEqual(844);
		await page.keyboard.press("Escape");
		await expect(create).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(create).toBeHidden();
		await expectNoHorizontalOverflow(page);
		await page.screenshot({ path: testInfo.outputPath("decision-flow-mobile.png"), fullPage: true });
	});
});

async function seedDecisionLedger(page: Page): Promise<DecisionSeed> {
	const token = uniqueToken("ledger");
	const currentTitle = `Use Qdrant current ${token}`;
	const historicalTitle = `Use Chroma historical ${token}`;
	const rejectedTitle = `Rejected graph store ${token}`;
	const archivedTitle = `Archived cache Decision ${token}`;
	const evidence = seedDecisionEvidence(token);

	const historical = await createAcceptedDecision(page, {
		title: historicalTitle,
		tags: ["vector"],
		context: `Historical vector context for ${token}.`,
		decision: `Use Chroma for historical storage ${token}.`,
		alternativesConsidered: "Use Qdrant.",
		consequences: "This guidance is retained for audit.",
	}, evidence);
	const current = await createAcceptedDecision(page, {
		title: currentTitle,
		tags: ["vector", "qdrant"],
		context: `Current vector context for ${token}.`,
		decision: `Use Qdrant for current production storage ${token}.`,
		alternativesConsidered: "Use Chroma.",
		consequences: "Default guidance points at Qdrant.",
	}, evidence, [historical.id]);
	await createRejectedDecision(page, {
		title: rejectedTitle,
		tags: ["graph"],
		context: `Rejected graph context ${token}.`,
		decision: `Do not use the rejected graph store ${token}.`,
	});
	seedArchivedDecision({
		title: archivedTitle,
		tags: ["cache"],
		context: `Archived cache context ${token}.`,
		decision: `Keep this cache Decision archived ${token}.`,
	});

	return {
		currentID: current.id,
		currentTitle,
		historicalTitle,
		rejectedTitle,
		archivedTitle,
		evidenceDoc: evidence.relatedDocs[0],
		evidenceTask: evidence.relatedTasks[0],
	};
}

type DecisionEvidence = {
	sources: string[];
	relatedDocs: string[];
	relatedTasks: string[];
};

function seedDecisionEvidence(label: string): DecisionEvidence {
	const docOutput = server.cli(`doc create "Decision evidence ${label}" --folder architecture --content "Verified decision evidence."`);
	const docPath = stripAnsi(docOutput).match(/Created doc:\s+(\S+)/)?.[1];
	expect(docPath, `could not parse doc path from: ${docOutput}`).toBeTruthy();
	const taskOutput = server.cli(`task create "Verify Decisions ${label}" --status done`);
	const taskID = taskOutput.match(/Created task\s+([a-z0-9]+):/)?.[1];
	expect(taskID, `could not parse task ID from: ${taskOutput}`).toBeTruthy();
	return {
		sources: [`@doc/${docPath!}`],
		relatedDocs: [docPath!],
		relatedTasks: [taskID!],
	};
}

async function createAcceptedDecision(
	page: Page,
	body: Record<string, unknown>,
	evidence: DecisionEvidence,
	supersedes: string[] = [],
) {
	const candidate = await createCandidate(page, { ...body, ...evidence, status: "draft" });
	const response = await page.request.post(`${server.baseURL}/api/decisions/${candidate.id}/accept`, {
		data: { supersedes },
	});
	expect(response.ok(), `accept failed with ${response.status()}: ${await response.text()}`).toBeTruthy();
	const result = await response.json() as { current?: { id: string; title: string }; decision?: { id: string; title: string } };
	return (result.current || result.decision)!;
}

async function createRejectedDecision(page: Page, body: Record<string, unknown>) {
	const candidate = await createCandidate(page, { ...body, status: "draft" });
	const response = await page.request.post(`${server.baseURL}/api/decisions/review/resolve`, {
		data: { candidateId: candidate.id, resolution: "reject_new" },
	});
	expect(response.ok(), `reject failed with ${response.status()}: ${await response.text()}`).toBeTruthy();
	return response.json();
}

async function createCandidate(page: Page, body: Record<string, unknown>): Promise<{ id: string; title: string }> {
	const response = await page.request.post(`${server.baseURL}/api/decisions`, { data: body });
	if (response.ok()) return response.json();
	if (response.status() === 409) {
		const result = await response.json() as { candidate?: { id: string; title: string } };
		expect(result.candidate, "review-required response should persist a candidate").toBeTruthy();
		return result.candidate!;
	}
	expect(response.ok(), `/api/decisions failed with ${response.status()}: ${await response.text()}`).toBeTruthy();
	return response.json();
}

function seedArchivedDecision(body: { title: string; tags: string[]; context: string; decision: string }) {
	const slug = body.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
	const id = `20260724-1200-${slug}`;
	const timestamp = "2026-07-24T12:00:00Z";
	writeFileSync(
		join(server.projectDir, ".knowns", "decisions", `${id}.md`),
		`---\nid: ${id}\ntitle: ${body.title}\nstatus: archived\nsupersedes: []\nsupersededBy: []\ntags:\n${body.tags.map((tag) => `  - ${tag}`).join("\n")}\nsources: []\nrelatedDocs: []\nrelatedTasks: []\nverification: []\ncreatedAt: '${timestamp}'\nupdatedAt: '${timestamp}'\n---\n\n## Context\n\n${body.context}\n\n## Decision\n\n${body.decision}\n\n## Alternatives Considered\n\n\n\n## Consequences\n\n`,
	);
	return { id, title: body.title };
}

function seedLegacyDecisionMemory(id: string, title: string) {
	const timestamp = "2026-07-24T12:00:00Z";
	writeFileSync(
		join(server.projectDir, ".knowns", "memory", `memory-${id}.md`),
		`---\nid: ${id}\ntitle: ${title}\nlayer: project\ncategory: decision\nstatus: active\nsources: []\ntags: []\ncreatedAt: '${timestamp}'\nupdatedAt: '${timestamp}'\n---\n\nThis legacy record should remain readable until explicitly migrated.\n`,
	);
}

function stripAnsi(value: string) {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function uniqueToken(label: string) {
	return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function expectNoHorizontalOverflow(page: Page) {
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	expect(overflow).toBeLessThanOrEqual(1);
}
