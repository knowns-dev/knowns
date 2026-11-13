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
	test("renders the Overview and its widgets", async ({ page }) => {
		await page.goto(server.baseURL);

		await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
		await expect(page.getByText(/^(Up to date|Partial data|Refreshing)$/)).toBeVisible();
		await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
		await expect(page.getByRole("tab", { name: "Analytics" })).toBeVisible();
		for (const tile of ["In progress", "Waiting for review", "Blocked", "Done this week"]) {
			await expect(page.getByRole("link", { name: new RegExp(tile) }).first()).toBeVisible();
		}
		for (const widget of ["Continue working", "Needs your attention", "Progress", "Waiting for you", "Recent activity", "Problems"]) {
			await expect(page.getByRole("heading", { name: widget, exact: true })).toBeVisible();
		}
	});

	test("exposes chart meaning and underlying data without hover", async ({ page }) => {
		await page.goto(server.baseURL);

		const progress = page.getByRole("region", { name: "Progress" });
		await expect(progress.getByRole("img", { name: /Tasks finished and added, last 30 days/ })).toBeVisible();
		// The chart's data table is for screen readers; it is in the page, not shown.
		await expect(progress.getByRole("columnheader", { name: "Finished" })).toBeAttached();
		await expect(progress.getByRole("columnheader", { name: "Added" })).toBeAttached();
		await expect(progress.getByText(/You finished 0 and added 2 tasks in the last 30 days/)).toBeVisible();
	});

	test("filters the analysis by label", async ({ page }) => {
		await page.goto(server.baseURL);
		await page.getByRole("tab", { name: "Analytics" }).click();
		await expect(page.getByText(/^2 tasks in this project$/)).toBeVisible();

		await page.getByRole("combobox", { name: "Filter by label" }).selectOption("dashboard");

		await expect(page.getByText(/^Showing 1 of 2 tasks$/)).toBeVisible();
		await page.getByRole("button", { name: "Clear filters" }).click();
		await expect(page.getByText(/^2 tasks in this project$/)).toBeVisible();
	});

	test("navigates to the board from a summary tile", async ({ page }) => {
		await page.goto(server.baseURL);
		await page.getByRole("link", { name: /Waiting for review/ }).click();
		await expect(page).toHaveURL(/\/kanban$/);
	});

	test("ranks the high-priority task in attention when no work is in progress", async ({ page }) => {
		await page.goto(server.baseURL);

		await expect(page.getByRole("region", { name: "Continue working" }).getByText(/Nothing is in progress/)).toBeVisible();
		const attention = page.getByRole("region", { name: "Needs your attention" });
		const row = attention.getByRole("link", { name: /Workbench Todo/ });
		await expect(row).toBeVisible();
		await expect(row.getByText("high priority", { exact: true })).toBeVisible();
		await expect(attention.getByText("Workbench Secondary")).toHaveCount(0);

		await row.click();
		await expect(page).toHaveURL(/\/tasks\/[a-z0-9.-]+$/i);
	});

	test("hides and restores a widget from Customize", async ({ page }) => {
		await page.goto(server.baseURL);
		await expect(page.getByRole("heading", { name: "Recent activity", exact: true })).toBeVisible();

		await page.getByRole("button", { name: "Customize" }).click();
		const sheet = page.getByRole("dialog", { name: "Customize overview" });
		await expect(sheet).toBeVisible();
		await sheet.getByRole("switch", { name: "Show Recent activity" }).click();
		await expect(page.getByRole("heading", { name: "Recent activity", exact: true })).toHaveCount(0);

		// The layout is kept in this browser across reloads.
		await page.reload();
		await expect(page.getByRole("heading", { name: "Problems", exact: true })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Recent activity", exact: true })).toHaveCount(0);

		await page.getByRole("button", { name: "Customize" }).click();
		await page.getByRole("dialog", { name: "Customize overview" }).getByRole("button", { name: "Reset to default" }).click();
		await expect(page.getByRole("heading", { name: "Recent activity", exact: true })).toBeVisible();
	});
});
