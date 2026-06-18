import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

type MemorySeed = {
	prefix: string;
	currentDecisionId: string;
	duplicateContent: string;
	activeTitle: string;
	proposedTitle: string;
	staleTitle: string;
	missingSourceTitle: string;
	brokenSourceTitle: string;
	supersededSourceTitle: string;
	archivedTitle: string;
};

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Memory Review Inbox", () => {
	test("opens to Review Inbox and groups actionable reasons", async ({ page }) => {
		const seed = await seedMemoryReview(page);
		await page.goto(`${server.baseURL}/memory`);

		await expect(page.getByRole("heading", { name: "Memory review" })).toBeVisible();
		await expect(page.getByRole("tab", { name: "Review Inbox" })).toHaveAttribute("aria-selected", "true");

		await expect(page.getByTestId("memory-review-group-proposed")).toContainText("Proposed");
		await expect(page.getByTestId("memory-review-group-duplicate_review")).toContainText("Duplicate review");
		await expect(page.getByTestId("memory-review-group-stale_ttl")).toContainText("Stale TTL");
		await expect(page.getByTestId("memory-review-group-missing_source")).toContainText("Missing source");
		await expect(page.getByTestId("memory-review-group-source_missing")).toContainText("Source missing");
		await expect(page.getByTestId("memory-review-group-source_decision_superseded")).toContainText("Source decision superseded");

		await expect(page.getByTestId("memory-review-group-proposed")).toContainText(seed.proposedTitle);
		await expect(page.getByTestId("memory-review-group-stale_ttl")).toContainText(seed.staleTitle);
		await expect(page.getByTestId("memory-review-group-missing_source")).toContainText(seed.missingSourceTitle);
		await expect(page.getByTestId("memory-review-group-source_missing")).toContainText(seed.brokenSourceTitle);
		await expect(page.getByTestId("memory-review-group-source_decision_superseded")).toContainText(seed.supersededSourceTitle);
	});

	test("keeps Healthy, Archived, and All as secondary views", async ({ page }) => {
		const seed = await seedMemoryReview(page);
		await page.goto(`${server.baseURL}/memory`);

		await page.getByRole("tab", { name: "Healthy" }).click();
		await expect(page.getByText("Healthy memories")).toBeVisible();
		await expect(page.getByText(seed.activeTitle)).toBeVisible();

		await page.getByRole("tab", { name: "Archived" }).click();
		await expect(page.getByText("Archived memories")).toBeVisible();
		await expect(page.getByText(seed.archivedTitle)).toBeVisible();

		await page.getByRole("tab", { name: "All" }).click();
		await expect(page.getByRole("heading", { name: "All memories" })).toBeVisible();
		await expect(page.getByText(seed.proposedTitle).first()).toBeVisible();
		await expect(page.getByText(seed.archivedTitle)).toBeVisible();
	});

	test("limits bulk actions to verify, archive, and reject proposed", async ({ page }) => {
		const seed = await seedMemoryReview(page);
		await page.goto(`${server.baseURL}/memory`);

		await page.getByLabel(`Select ${seed.proposedTitle}`).first().check();
		const toolbar = page.getByTestId("memory-bulk-toolbar");

		await expect(toolbar.getByRole("button", { name: "Verify" })).toBeVisible();
		await expect(toolbar.getByRole("button", { name: "Archive" })).toBeVisible();
		await expect(toolbar.getByRole("button", { name: "Reject proposed" })).toBeEnabled();
		await expect(toolbar.getByRole("button", { name: /merge/i })).toHaveCount(0);
		await expect(toolbar.getByRole("button", { name: /update existing/i })).toHaveCount(0);

		await toolbar.getByRole("button", { name: "Reject proposed" }).click();
		await expect(page.getByTestId("memory-review-group-proposed")).not.toContainText(seed.proposedTitle);
	});

	test("supports item duplicate actions and superseded-source repair", async ({ page }) => {
		const seed = await seedMemoryReview(page);
		await page.goto(`${server.baseURL}/memory`);

		await page.getByTestId("memory-review-group-proposed").getByText(seed.proposedTitle).click();
		const detail = page.getByTestId("memory-detail-panel");
		await expect(detail).toContainText("Duplicate candidates");
		await expect(detail.getByRole("button", { name: "Update existing" })).toBeVisible();
		await expect(detail.getByRole("button", { name: "Merge" })).toBeVisible();
		await expect(detail.getByRole("button", { name: "Create proposed" })).toBeVisible();
		await expect(detail.getByRole("button", { name: "Verify" })).toBeVisible();
		await expect(detail.getByRole("button", { name: "Archive" })).toBeVisible();
		await expect(detail.getByRole("button", { name: "Reject" })).toBeVisible();
		await expect(detail.getByRole("button", { name: "Link source" })).toBeVisible();

		await page.getByTestId("memory-review-group-source_decision_superseded").getByText(seed.supersededSourceTitle).click();
		await expect(detail.getByRole("button", { name: "Repair source" })).toBeVisible();
		await detail.getByRole("button", { name: "Repair source" }).click();
		await expect(page.getByTestId("memory-review-group-source_decision_superseded")).not.toContainText(seed.supersededSourceTitle);
	});

	test("shows duplicate candidates and supports Create anyway", async ({ page }) => {
		const seed = await seedMemoryReview(page);
		await page.goto(`${server.baseURL}/memory`);

		const overrideTitle = `Override duplicate ${seed.prefix}`;
		await page.getByRole("button", { name: "New memory" }).click();
		await page.locator('input[placeholder="Optional title"]').fill(overrideTitle);
		await page.locator('textarea[placeholder="Write in markdown"]').fill(seed.duplicateContent);
		await page.locator('input[placeholder="@doc/path, @task/id, or @decision/id"]').fill(`@decision/${seed.currentDecisionId}`);
		await page.getByRole("button", { name: "Create" }).click();

		await expect(page.getByText("Similar memories need review")).toBeVisible();
		await expect(page.locator('[role="dialog"]').getByText(seed.activeTitle, { exact: true })).toBeVisible();

		await page.getByRole("button", { name: "Create anyway" }).click();
		await expect(page.getByText("Similar memories need review")).toHaveCount(0);
		await expect(page.getByText(overrideTitle).first()).toBeVisible();
	});

	test("has no horizontal overflow in desktop and mobile key viewports", async ({ page }, testInfo) => {
		await seedMemoryReview(page);

		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto(`${server.baseURL}/memory`);
		await expect(page.getByRole("heading", { name: "Memory review" })).toBeVisible();
		await expect(page.getByTestId("memory-review-group-proposed")).toBeVisible();
		await expectNoHorizontalOverflow(page);
		await expectControlsFit(page);
		await page.screenshot({ path: testInfo.outputPath("memory-review-desktop.png"), fullPage: true });

		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(`${server.baseURL}/memory`);
		await expect(page.getByRole("heading", { name: "Memory review" })).toBeVisible();
		await expect(page.getByTestId("memory-review-group-proposed")).toBeVisible();
		await expect(page.getByRole("tab", { name: "Review Inbox" })).toBeVisible();
		await expect(page.getByRole("button", { name: "New memory" })).toBeVisible();
		await expectNoHorizontalOverflow(page);
		await expectControlsFit(page);
		await page.screenshot({ path: testInfo.outputPath("memory-review-mobile.png"), fullPage: true });
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

	await createMemory(page, {
		title: activeTitle,
		content: duplicateContent,
		status: "active",
		category: "decision",
		sources: [`@decision/${currentDecision.id}`],
	});
	await createMemory(page, {
		title: proposedTitle,
		content: duplicateContent,
		status: "proposed",
		category: "decision",
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
		activeTitle,
		proposedTitle,
		staleTitle,
		missingSourceTitle,
		brokenSourceTitle,
		supersededSourceTitle,
		archivedTitle,
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

async function createMemory(page: Page, body: Record<string, unknown>) {
	return postJSON(page, "/api/memories", { ...body, layer: "project", skipReview: true });
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
