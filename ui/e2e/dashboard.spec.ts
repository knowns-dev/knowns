import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
	server.cli('task create "Workbench Todo" -d "Dashboard test task" --priority high -l "dashboard"');
	server.cli('task create "Workbench Secondary" -d "Another dashboard task" --priority medium -l "api"');
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Dashboard", () => {
	test("renders the analysis workbench and its primary signals", async ({ page }) => {
		await page.goto(server.baseURL);

		await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
		await expect(page.getByText(/All sources ready|Partial data|Refreshing/)).toBeVisible();
		await expect(page.getByRole("heading", { name: "Throughput" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Work aging" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Lead time" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Knowledge health" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Project pulse" })).toBeVisible();
	});

	test("exposes chart meaning and underlying data without hover", async ({ page }) => {
		await page.goto(server.baseURL);

		await expect(page.getByRole("img", { name: /Created and completed task throughput/ })).toBeVisible();
		await page.getByText("View throughput data").click();
		await expect(page.getByRole("columnheader", { name: "Created" })).toBeVisible();
		await expect(page.getByRole("columnheader", { name: "Completed" })).toBeVisible();
		await expect(page.getByText(/Created → completed · completions in the last 30 days/)).toBeVisible();
	});

	test("filters the analysis by label", async ({ page }) => {
		await page.goto(server.baseURL);
		await expect(page.getByText(/\d+ tasks in range/).first()).toBeVisible();

		await page.getByRole("combobox", { name: "Filter by label" }).click();
		await page.getByRole("option", { name: "dashboard" }).click();

		await expect(page.getByText("task in range")).toBeVisible();
	});

	test("navigates to the task inventory from project pulse", async ({ page }) => {
		await page.goto(server.baseURL);
		await page.getByRole("link", { name: "All tasks" }).click();
		await expect(page).toHaveURL(/\/tasks$/);
	});

	test("recommends the highest-ranked attention task when no work is in progress", async ({ page }) => {
		await page.goto(server.baseURL);

		await expect(page.getByText("Next recommended", { exact: true })).toBeVisible();
		await expect(page.getByText("Workbench Todo", { exact: true })).toBeVisible();
		await expect(page.getByText(/Why now: high priority/)).toBeVisible();
		await expect(page.getByRole("link", { name: /Review task/ })).toBeVisible();
	});
});
