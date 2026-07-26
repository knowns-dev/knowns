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
			await expect(boardSection).toBeVisible({ timeout: 5000 });
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

	test("keeps category navigation and active content usable on mobile", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(`${server.baseURL}/config`);

		const settingsTabs = page.getByRole("tablist", { name: "Settings categories" });
		const generalTab = settingsTabs.getByRole("tab", { name: "General" });
		await expect(settingsTabs).toBeVisible();
		await expect(generalTab).toBeVisible();
		await expect(generalTab).toHaveAttribute("aria-selected", "true");
		await expect(page.getByRole("heading", { name: "Project", exact: true })).toBeVisible();

		const codeTab = settingsTabs.getByRole("tab", { name: "Code", exact: true });
		await codeTab.click();
		await expect(codeTab).toHaveAttribute("aria-selected", "true");
		await expect(page.getByRole("heading", { name: "Language Server Protocol", exact: true })).toBeVisible();

		const codeTabBox = await codeTab.boundingBox();
		expect(codeTabBox).not.toBeNull();
		expect(codeTabBox!.x).toBeGreaterThanOrEqual(0);
		expect(codeTabBox!.x + codeTabBox!.width).toBeLessThanOrEqual(390);

		const viewportOverflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
		);
		expect(viewportOverflow).toBeLessThanOrEqual(1);
	});
});
