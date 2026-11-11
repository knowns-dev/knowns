import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

// KN-QP42KA: the Dashboard shows a first-run checklist that ticks from real project state,
// and empty Tasks, Docs, Memories and Decisions pages show an illustration with a first action.

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

const step = (page: import("@playwright/test").Page, title: string) =>
	page.getByRole("region", { name: "Get started" }).getByRole("listitem").filter({ hasText: title });

test.describe("Onboarding checklist", () => {
	test("ticks a step from project state and stays dismissed", async ({ page }) => {
		await page.goto(server.baseURL);
		const card = page.getByRole("region", { name: "Get started" });
		await expect(card).toBeVisible();
		await expect(step(page, "Create a Task")).not.toContainText(/, done/i);

		server.cli('task create "First Task"');
		await page.reload();
		await expect(step(page, "Create a Task")).toContainText(/, done/i);

		await card.getByRole("button", { name: "Dismiss" }).click();
		await expect(card).toHaveCount(0);
		await page.reload();
		await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
		await expect(page.getByRole("region", { name: "Get started" })).toHaveCount(0);
	});

	test("Remind me later hides the card for this page view", async ({ page }) => {
		await page.goto(server.baseURL);
		await page.evaluate(() => localStorage.removeItem("knowns-onboarding-dismissed-v1"));
		await page.reload();
		const card = page.getByRole("region", { name: "Get started" });
		await card.getByRole("button", { name: "Remind me later" }).click();
		await expect(card).toHaveCount(0);
	});
});

test.describe("Empty states", () => {
	let empty: TestServer;
	test.beforeAll(async () => {
		empty = await startServer();
	});
	test.afterAll(() => empty?.cleanup());

	test("Tasks offers a first Task", async ({ page }) => {
		await page.goto(`${empty.baseURL}/tasks`);
		const state = page.getByTestId("tasks-empty");
		await expect(state.getByText("No Tasks yet")).toBeVisible();
		// One "New Task" control: the header's, not a second copy inside the empty state.
		await expect(page.getByRole("button", { name: /new task/i })).toHaveCount(1);
	});

	test("the board keeps its empty columns", async ({ page }) => {
		await page.goto(`${empty.baseURL}/kanban`);
		await expect(page.getByRole("region", { name: "Task board" })).toBeVisible();
		await expect(page.getByTestId("tasks-empty")).toHaveCount(0);
	});

	test("Memories offers a first proposal", async ({ page }) => {
		await page.goto(`${empty.baseURL}/memory`);
		const state = page.getByTestId("memory-empty");
		await expect(state.getByText("No Memories yet")).toBeVisible();
		await expect(state.getByRole("button", { name: "Propose a Memory" })).toBeVisible();
	});

	test("Decisions offers a first proposal", async ({ page }) => {
		await page.goto(`${empty.baseURL}/decisions`);
		await expect(page.getByTestId("decision-empty").getByRole("button", { name: "Propose a Decision" })).toBeVisible();
	});
});
