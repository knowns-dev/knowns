import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Configuration Page", () => {
	test("shows config page with project settings", async ({ page }) => {
		await test.step("Navigate to config page", async () => {
			await page.goto(`${server.baseURL}/config`);
		});

		await test.step("Config page loads", async () => {
			await expect(page.getByText(/config|settings/i).first()).toBeVisible();
		});

		await test.step("Project name field is visible", async () => {
			await expect(page.getByText(/project name|name/i).first()).toBeVisible();
		});
	});

	test("shows board status configuration", async ({ page }) => {
		await test.step("Navigate to config page", async () => {
			await page.goto(`${server.baseURL}/config`);
		});

		await test.step("Board section is visible", async () => {
			const boardSection = page.getByText(/board|statuses/i).first();
			await expect(boardSection).toBeVisible();
		});
	});

	test("displays default task settings", async ({ page }) => {
		await test.step("Navigate to config page", async () => {
			await page.goto(`${server.baseURL}/config`);
		});

		await test.step("Default settings fields are visible", async () => {
			// Look for priority or assignee defaults
			await expect(page.getByText(/priority|assignee|default/i).first()).toBeVisible();
		});
	});
});
