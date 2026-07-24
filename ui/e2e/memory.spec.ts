import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

type MemorySeed = {
	prefix: string;
	currentDecisionId: string;
	duplicateContent: string;
	activeId: string;
	activeTitle: string;
	proposedTitle: string;
	staleTitle: string;
	missingSourceTitle: string;
	brokenSourceTitle: string;
	supersededSourceTitle: string;
	archivedTitle: string;
	recommendedDocTitle: string;
	recommendedDocRef: string;
	recommendedTaskTitle: string;
	recommendedTaskRef: string;
};

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Memory lifecycle destinations", () => {
	test("keeps Trusted read-only and separates Review Inbox and History by URL", async ({ page }) => {
		const seed = await seedMemoryReview(page);
		await page.goto(`${server.baseURL}/memory`);

		await expect(page.getByRole("heading", { name: "Memories", exact: true })).toBeVisible();
		await expect(page.getByRole("tab", { name: /Trusted/ })).toHaveAttribute("aria-selected", "true");
		await expect(page.getByTestId("memory-trusted-destination")).toBeVisible();
		await expect(page.getByText(seed.activeTitle, { exact: true })).toBeVisible();
		await expect(page.getByText(seed.proposedTitle, { exact: true })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "New proposal" })).toHaveCount(0);

		await page.getByText(seed.activeTitle, { exact: true }).click();
		await expect(page.getByTestId("memory-readonly-detail")).toBeVisible();
		await expect(page.getByText("Available to default retrieval")).toBeVisible();
		await expect(page.getByRole("button", { name: "Remove from Trusted" })).toBeVisible();
		await expect(page.getByRole("button", { name: /delete|permanent/i })).toHaveCount(0);
		await expect(page.getByRole("button", { name: /Review (activation|archive|rejection)/ })).toHaveCount(0);
		await page.getByRole("button", { name: "Close Memory detail" }).click();

		await page.getByRole("tab", { name: /Review Inbox/ }).click();
		await expect(page).toHaveURL(/\/memory\/review$/);
		await expect(page.getByTestId("memory-review-destination")).toBeVisible();
		await expect(page.getByText(seed.proposedTitle, { exact: true })).toHaveCount(1);
		await expect(page.getByText(seed.staleTitle, { exact: true })).toHaveCount(1);
		await expect(page.getByText(seed.missingSourceTitle, { exact: true })).toHaveCount(1);
		await expect(page.getByText(seed.brokenSourceTitle, { exact: true })).toHaveCount(1);
		await expect(page.getByText(seed.supersededSourceTitle, { exact: true })).toHaveCount(1);

		await page.getByRole("tab", { name: /History/ }).click();
		await expect(page).toHaveURL(/\/memory\/history$/);
		await expect(page.getByTestId("memory-history-destination")).toBeVisible();
		await expect(page.getByText(seed.archivedTitle, { exact: true })).toBeVisible();
	});

	test("removes Trusted recall through archive confirmation and preserves it in History", async ({ page }) => {
		const seed = await seedMemoryReview(page);
		await page.goto(`${server.baseURL}/memory`);

		await page.getByTestId(`memory-row-${seed.activeId}`).click();
		const detail = page.getByTestId("memory-readonly-detail");
		await detail.getByRole("button", { name: "Remove from Trusted" }).click();

		const impact = page.getByTestId("memory-impact-dialog");
		await expect(impact).toBeVisible();
		await expect(impact).toContainText("Provenance is retained");
		await expect(impact).toContainText(
			"Archived; excluded from default retrieval and moved to History.",
		);
		await impact.getByRole("button", { name: "Cancel" }).click();
		await expect(impact).toHaveCount(0);
		await expect(detail).toBeVisible();

		await detail.getByRole("button", { name: "Remove from Trusted" }).click();
		await page
			.getByTestId("memory-impact-dialog")
			.getByRole("button", { name: "Confirm outcome" })
			.click();

		await expect(page.getByTestId(`memory-row-${seed.activeId}`)).toHaveCount(0);
		await expect(page.getByRole("tab", { name: /Trusted/ })).toBeFocused();

		await page.getByRole("tab", { name: /History/ }).click();
		await expect(page.getByTestId(`memory-row-${seed.activeId}`)).toBeVisible();
		await page.getByTestId(`memory-row-${seed.activeId}`).click();
		const historicalDetail = page.getByTestId("memory-readonly-detail");
		await expect(historicalDetail).toContainText("Historical record");
		await expect(historicalDetail).toContainText(`@decision/${seed.currentDecisionId}`);
		await expect(historicalDetail.getByRole("button", { name: "Remove from Trusted" })).toHaveCount(0);
		await expect(historicalDetail.getByRole("button", { name: /delete|permanent/i })).toHaveCount(0);
	});

	test("shows explicit impact before item and bulk review outcomes", async ({ page }) => {
		const seed = await seedMemoryReview(page);
		await page.goto(`${server.baseURL}/memory/review`);

		await page.getByText(seed.proposedTitle, { exact: true }).click();
		const detail = page.getByTestId("memory-review-detail");
		await expect(detail).toContainText("Similar trusted Memories");
		await expect(detail.getByRole("button", { name: "Review merge" })).toBeVisible();
		await expect(detail.getByRole("button", { name: "Review activation" })).toBeVisible();
		await expect(detail.getByRole("button", { name: /Update existing/i })).toHaveCount(0);

		await detail.getByRole("button", { name: "Review activation" }).click();
		const impact = page.getByTestId("memory-impact-dialog");
		await expect(impact).toBeVisible();
		await expect(impact).toContainText("Memory");
		await expect(impact).toContainText("Evidence outcome");
		await expect(impact).toContainText("Resulting lifecycle");
		await expect(impact).toContainText("Active; included in default retrieval");
		await impact.getByRole("button", { name: "Cancel" }).click();
		await expect(impact).toHaveCount(0);

		await page.getByRole("button", { name: "Close Memory detail" }).click();
		await page.getByLabel(`Select ${seed.proposedTitle}`).check();
		const toolbar = page.getByTestId("memory-bulk-toolbar");
		await expect(toolbar.getByRole("button", { name: "Verify" })).toBeEnabled();
		await expect(toolbar.getByRole("button", { name: "Archive" })).toBeEnabled();
		await expect(toolbar.getByRole("button", { name: "Reject proposed" })).toBeEnabled();
		await expect(toolbar.getByRole("button", { name: /merge/i })).toHaveCount(0);
		await toolbar.getByRole("button", { name: "Reject proposed" }).click();
		await expect(page.getByRole("heading", { name: "Confirm bulk outcome" })).toBeVisible();
		await page.getByRole("button", { name: "Cancel" }).click();
	});

	test("keeps source selection above focus view and confirms repairs", async ({ page }) => {
		const seed = await seedMemoryReview(page);
		await page.goto(`${server.baseURL}/memory/review`);

		await page.getByText(seed.missingSourceTitle, { exact: true }).click();
		const focus = page.getByTestId("memory-focus-dialog");
		await focus.getByRole("button", { name: "Browse existing" }).click();
		const browser = page.getByTestId("reference-browser");
		await expect(browser).toBeVisible();
		const layers = await page.evaluate(() => {
			const focusDialog = document.querySelector('[data-testid="memory-focus-dialog"]');
			const referenceBrowser = document.querySelector('[data-testid="reference-browser"]');
			return {
				focus: Number.parseInt(getComputedStyle(focusDialog as Element).zIndex || "0", 10),
				browser: Number.parseInt(getComputedStyle(referenceBrowser as Element).zIndex || "0", 10),
			};
		});
		expect(layers.browser).toBeGreaterThan(layers.focus);
		await page.keyboard.press("Escape");
		await expect(browser).toHaveCount(0);

		await page.getByRole("button", { name: "Close Memory detail" }).click();
		await page.getByText(seed.supersededSourceTitle, { exact: true }).click();
		await page.getByRole("button", { name: "Review repair" }).click();
		const impact = page.getByTestId("memory-impact-dialog");
		await expect(impact).toContainText(`@decision/${seed.currentDecisionId}`);
		await impact.getByRole("button", { name: "Confirm outcome" }).click();
		await expect(page.getByText(seed.supersededSourceTitle, { exact: true })).toHaveCount(0);
	});

	test("recommends nearby docs and tasks but stages selection until confirmation", async ({ page }) => {
		const seed = await seedMemoryReview(page);
		await page.goto(`${server.baseURL}/memory/review`);

		await page.getByText(seed.missingSourceTitle, { exact: true }).click();
		const recommendations = page.getByTestId("memory-source-recommendations");
		await expect(recommendations).toBeVisible();
		await expect(recommendations.getByText(seed.recommendedDocTitle, { exact: true })).toBeVisible();
		await expect(recommendations.getByText(seed.recommendedTaskTitle, { exact: true })).toBeVisible();
		expect(await recommendations.locator("li").count()).toBeLessThanOrEqual(3);

		await recommendations.getByRole("button", { name: `Select doc: ${seed.recommendedDocTitle}` }).click();
		await expect(recommendations.getByRole("button", { name: `Selected doc: ${seed.recommendedDocTitle}` })).toBeVisible();
		const sourceInput = page.getByTestId("memory-source-panel").locator('input[placeholder="@doc/path, @task/id, https://…"]');
		await expect(sourceInput).toHaveValue(seed.recommendedDocRef);

		await page.getByRole("button", { name: "Review source update" }).click();
		const impact = page.getByTestId("memory-impact-dialog");
		await expect(impact).toContainText(seed.recommendedDocRef);
		await impact.getByRole("button", { name: "Cancel" }).click();
		await expect(sourceInput).toHaveValue(seed.recommendedDocRef);

		await page.getByRole("button", { name: "Review source update" }).click();
		await page.getByTestId("memory-impact-dialog").getByRole("button", { name: "Confirm outcome" }).click();
		await expect(page.getByText(seed.missingSourceTitle, { exact: true })).toHaveCount(0);
	});

	test("keeps manual source repair usable when recommendations fail", async ({ page }) => {
		const seed = await seedMemoryReview(page);
		await page.route("**/api/search?*", (route) =>
			route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' }),
		);
		await page.goto(`${server.baseURL}/memory/review`);

		await page.getByText(seed.brokenSourceTitle, { exact: true }).click();
		const recommendations = page.getByTestId("memory-source-recommendations");
		await expect(recommendations.getByText("Suggestions are unavailable. Manual source entry still works.")).toBeVisible();
		const sourcePanel = page.getByTestId("memory-source-panel");
		await sourcePanel.locator('input[placeholder="@doc/path, @task/id, https://…"]').fill(seed.recommendedDocRef);
		await expect(sourcePanel.getByRole("button", { name: "Review source update" })).toBeEnabled();
		await sourcePanel.getByRole("button", { name: "Review source update" }).click();
		await expect(page.getByTestId("memory-impact-dialog")).toContainText(seed.recommendedDocRef);
	});

	test("creates manual recall only as a proposal and returns it to Review Inbox", async ({ page }) => {
		const seed = await seedMemoryReview(page);
		await page.goto(`${server.baseURL}/memory/review`);

		const overrideTitle = `Override duplicate ${seed.prefix}`;
		await page.getByRole("button", { name: "New proposal" }).click();
		await page.locator('input[placeholder="Optional title"]').fill(overrideTitle);
		await page.locator('textarea[placeholder="Write durable recall in markdown"]').fill(seed.duplicateContent);
		await page.locator('input[placeholder="@doc/path, @task/id, https://…"]').fill(`@decision/${seed.currentDecisionId}`);
		await page.getByRole("button", { name: "Save proposal" }).click();

		await expect(page.getByText("Similar trusted Memories found")).toBeVisible();
		await expect(page.getByTestId("memory-create-dialog").getByText(seed.activeTitle, { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Keep separate as proposal" }).click();
		await expect(page.getByText("Similar trusted Memories found")).toHaveCount(0);
		await expect(page).toHaveURL(/\/memory\/review$/);
		await expect(page.getByText(overrideTitle, { exact: true })).toBeVisible();
	});

	test("routes durable choices to System Decisions instead of Decision Memory", async ({ page }) => {
		await page.goto(`${server.baseURL}/memory/review`);
		await page.getByRole("button", { name: "New proposal" }).click();
		const dialog = page.getByTestId("memory-create-dialog");
		await dialog.locator('textarea[placeholder="Write durable recall in markdown"]').fill("Use the durable system contract.");
		await dialog.locator('input[placeholder="pattern, convention, preference…"]').fill(" Decision ");
		await expect(dialog.getByText(/Memory category “decision” is legacy/)).toBeVisible();
		await expect(dialog.getByRole("button", { name: "Save proposal" })).toBeDisabled();
	});

	test("keeps Trusted readable when review metadata fails", async ({ page }) => {
		const seed = await seedMemoryReview(page);
		await page.route("**/api/memories/review", (route) =>
			route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' }),
		);
		await page.goto(`${server.baseURL}/memory`);

		await expect(page.getByText(seed.activeTitle, { exact: true })).toBeVisible();
		await expect(page.getByText(/Review metadata is unavailable/)).toBeVisible();
		await page.getByRole("tab", { name: /Review Inbox/ }).click();
		await expect(page.getByText("Review Inbox is temporarily unavailable")).toBeVisible();
	});

	test("has no horizontal overflow in desktop and mobile key viewports", async ({ page }, testInfo) => {
		const seed = await seedMemoryReview(page);

		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto(`${server.baseURL}/memory/review`);
		await expect(page.getByRole("heading", { name: "Memories", exact: true })).toBeVisible();
		await expect(page.getByTestId("memory-review-destination")).toBeVisible();
		await expectNoHorizontalOverflow(page);
		await expectControlsFit(page);
		await page.screenshot({ path: testInfo.outputPath("memory-review-desktop.png"), fullPage: true });

		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(`${server.baseURL}/memory/review`);
		await expect(page.getByRole("heading", { name: "Memories", exact: true })).toBeVisible();
		await expect(page.getByTestId("memory-review-destination")).toBeVisible();
		await expect(page.getByRole("tab", { name: /Review Inbox/ })).toBeVisible();
		await expect(page.getByRole("button", { name: "New proposal" })).toBeVisible();
		await expectNoHorizontalOverflow(page);
		await expectControlsFit(page);
		await page.screenshot({ path: testInfo.outputPath("memory-review-mobile.png"), fullPage: true });

		await page.getByText(seed.missingSourceTitle, { exact: true }).click();
		const mobileRecommendations = page.getByTestId("memory-source-recommendations");
		await expect(mobileRecommendations).toBeVisible();
		await mobileRecommendations.scrollIntoViewIfNeeded();
		await expectNoHorizontalOverflow(page);
		await page.screenshot({ path: testInfo.outputPath("memory-source-recommendations-mobile.png"), fullPage: true });
	});
});

async function seedMemoryReview(page: Page): Promise<MemorySeed> {
	const prefix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
	const safePrefix = prefix.toLowerCase().replace(/[^a-z0-9]+/g, "-");
	const currentDecision = {
		id: `20260618-1024-current-vector-${safePrefix}`,
		title: `Current vector decision ${prefix}`,
		decision: `Use Qdrant as the default vector database for ${prefix}.`,
	};
	const oldDecision = {
		id: `20260401-0900-historical-vector-${safePrefix}`,
		title: `Historical vector decision ${prefix}`,
		decision: `Use Chroma as the default vector database for ${prefix}.`,
	};
	writeDecisionFile(oldDecision.id, oldDecision.title, oldDecision.decision, {
		status: "superseded",
		supersededBy: [currentDecision.id],
	});
	writeDecisionFile(currentDecision.id, currentDecision.title, currentDecision.decision, {
		status: "accepted",
		supersedes: [oldDecision.id],
	});

	const activeTitle = `Active duplicate target ${prefix}`;
	const proposedTitle = `Proposed duplicate ${prefix}`;
	const staleTitle = `Stale TTL ${prefix}`;
	const missingSourceTitle = `Missing source ${prefix}`;
	const brokenSourceTitle = `Broken source ${prefix}`;
	const supersededSourceTitle = `Superseded source ${prefix}`;
	const archivedTitle = `Archived memory ${prefix}`;
	const duplicateContent = `Use Qdrant as the default vector database for ${prefix}.`;
	const recommendedDocTitle = `Source evidence guide ${prefix}`;
	const recommendedTaskTitle = `Verify source evidence ${prefix}`;
	const recommendedDoc = await postJSON<{ path: string }>(page, "/api/docs", {
		title: recommendedDocTitle,
		description: `Evidence for ${missingSourceTitle} and its durable retrieval context.`,
		content: `# ${recommendedDocTitle}\n\nEvidence for ${missingSourceTitle}.`,
		folder: "evidence",
		tags: ["memory", "evidence"],
	});
	const recommendedTask = await postJSON<{ id: string }>(page, "/api/tasks", {
		title: recommendedTaskTitle,
		description: `Verify the evidence linked to ${missingSourceTitle}.`,
		status: "todo",
		priority: "medium",
		labels: ["memory", "evidence"],
	});

	const activeMemory = await createMemory(page, {
		title: activeTitle,
		content: duplicateContent,
		status: "active",
		category: "pattern",
		sources: [`@decision/${currentDecision.id}`],
	});
	await createMemory(page, {
		title: proposedTitle,
		content: duplicateContent,
		status: "proposed",
		category: "pattern",
		sources: [`@decision/${currentDecision.id}`],
	});
	await createMemory(page, {
		title: staleTitle,
		content: "Recheck this TTL-bound memory.",
		status: "stale",
		sources: [`@decision/${currentDecision.id}`],
	});
	await createMemory(page, {
		title: missingSourceTitle,
		content: "This active memory needs a source.",
		status: "active",
	});
	await createMemory(page, {
		title: brokenSourceTitle,
		content: "This source path is gone.",
		status: "active",
		sources: [`@doc/missing-${prefix}`],
	});
	await createMemory(page, {
		title: supersededSourceTitle,
		content: "This points to historical decision guidance.",
		status: "active",
		sources: [`@decision/${oldDecision.id}`],
	});
	await createMemory(page, {
		title: archivedTitle,
		content: "Archived memory for tab coverage.",
		status: "archived",
		sources: [`@decision/${currentDecision.id}`],
	});

	return {
		prefix,
		currentDecisionId: currentDecision.id,
		duplicateContent,
		activeId: activeMemory.id,
		activeTitle,
		proposedTitle,
		staleTitle,
		missingSourceTitle,
		brokenSourceTitle,
		supersededSourceTitle,
		archivedTitle,
		recommendedDocTitle,
		recommendedDocRef: `@doc/${recommendedDoc.path}`,
		recommendedTaskTitle,
		recommendedTaskRef: `@task/${recommendedTask.id}`,
	};
}

function writeDecisionFile(
	id: string,
	title: string,
	decision: string,
	options: { status: "accepted" | "superseded"; supersedes?: string[]; supersededBy?: string[] },
) {
	const dir = join(server.projectDir, ".knowns", "decisions");
	mkdirSync(dir, { recursive: true });
	const now = "2026-06-18T10:24:00Z";
	const listYaml = (name: string, values?: string[]) => {
		if (!values || values.length === 0) return "";
		return `${name}:\n${values.map((value) => `  - ${value}`).join("\n")}\n`;
	};
	writeFileSync(
		join(dir, `${id}.md`),
		`---\n` +
			`id: ${id}\n` +
			`title: ${title}\n` +
			`status: ${options.status}\n` +
			listYaml("supersedes", options.supersedes) +
			listYaml("supersededBy", options.supersededBy) +
			`tags: []\n` +
			`relatedDocs:\n  - specs/vector\n` +
			`createdAt: '${now}'\n` +
			`updatedAt: '${now}'\n` +
			`---\n\n` +
			`${decision}\n\n` +
			`## Context\n\n` +
			`## Decision\n\n${decision}\n\n` +
			`## Alternatives Considered\n\n` +
			`## Consequences\n`,
	);
}

async function createMemory(page: Page, body: Record<string, unknown>): Promise<{ id: string }> {
	return postJSON<{ id: string }>(page, "/api/memories", {
		...body,
		layer: "project",
		skipReview: true,
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
	const overflowing = await page.locator('[role="tab"], [data-testid="memory-bulk-toolbar"] button').evaluateAll((elements) =>
		elements
			.filter((element) => {
				const rect = element.getBoundingClientRect();
				return rect.width > 0 && element.scrollWidth > element.clientWidth + 1;
			})
			.map((element) => element.textContent?.trim() || element.getAttribute("aria-label") || "control"),
	);
	expect(overflowing).toEqual([]);
}
