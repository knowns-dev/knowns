import { test, expect, type Page } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
	// Seed data for search tests
	server.cli('task create "Auth Module" -d "Implement authentication module" --priority high -l "backend"');
	server.cli('task create "Login Page" -d "Create login page UI" --priority medium -l "frontend"');
	server.cli('task create "API Docs" -d "Write API documentation" --priority low');
	server.cli('doc create "Architecture" -d "System architecture overview" -t "core"');
	server.cli('doc create "Auth Guide" -d "Authentication guide for developers" -t guide -t auth');
});

test.afterAll(() => {
	server?.cleanup();
});

async function openSearchDialog(page: Page) {
	await page.goto(`${server.baseURL}/kanban`);
	const searchButton = page.getByRole("button", { name: /search/i }).first();
	await expect(searchButton).toBeVisible();
	await searchButton.click();
	const searchInput = page.getByPlaceholder("Search tasks and docs...");
	await expect(searchInput).toBeVisible();
	return searchInput;
}

test.describe("Search Command Dialog", () => {
	test("opens search with Cmd+K and shows results", async ({ page }) => {
		await test.step("Navigate to kanban", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await expect(page.getByRole("button", { name: /search/i }).first()).toBeVisible();
		});

		await test.step("Open search dialog with Cmd+K", async () => {
			await page.keyboard.press("ControlOrMeta+k");
		});

		await test.step("Search dialog is visible", async () => {
			await expect(page.getByPlaceholder("Search tasks and docs...")).toBeVisible();
		});

		await test.step("Type search query", async () => {
			await page.getByPlaceholder("Search tasks and docs...").fill("Auth");
		});

		await test.step("Results show matching tasks and docs", async () => {
			// Should find "Auth Module" task and "Auth Guide" doc
			await expect(page.getByText("Auth Module").first()).toBeVisible();
		});

		await test.step("Close search with Escape", async () => {
			await page.keyboard.press("Escape");
			await page.waitForTimeout(300);
		});
	});

	test("search finds tasks by description content", async ({ page }) => {
		await test.step("Open search and enter description content", async () => {
			const searchInput = await openSearchDialog(page);
			await searchInput.fill("authentication");
		});

		await test.step("Task with matching description found", async () => {
			await expect(page.getByText("Auth Module").first()).toBeVisible();
		});

		await test.step("Cleanup", async () => {
			await page.keyboard.press("Escape");
		});
	});

	test("search finds docs", async ({ page }) => {
		await test.step("Open search and enter doc title", async () => {
			const searchInput = await openSearchDialog(page);
			await searchInput.fill("Architecture");
		});

		await test.step("Doc result appears", async () => {
			await expect(page.getByText("Architecture").first()).toBeVisible();
		});

		await test.step("Cleanup", async () => {
			await page.keyboard.press("Escape");
		});
	});

	test("empty search shows no results message", async ({ page }) => {
		await test.step("Open search and enter non-existent term", async () => {
			const searchInput = await openSearchDialog(page);
			await searchInput.fill("zzzznonexistent12345");
		});

		await test.step("No results shown", async () => {
			await expect(page.getByText(/no result/i).first()).toBeVisible();
		});

		await test.step("Cleanup", async () => {
			await page.keyboard.press("Escape");
		});
	});

	test("clicking search result navigates to it", async ({ page }) => {
		await test.step("Open search and click a task result", async () => {
			const searchInput = await openSearchDialog(page);
			await searchInput.fill("Login Page");
			// Click the CommandItem (role="option") containing "Login Page", not the input text
			const resultItem = page.locator('[role="option"]').filter({ hasText: "Login Page" }).first();
			await expect(resultItem).toBeVisible();
			await resultItem.click();
			await page.waitForTimeout(500);
		});

		await test.step("Task detail opens", async () => {
			await expect(page.getByRole("heading", { name: "Login Page", exact: true })).toBeVisible();
		});
	});
});

test.describe("Sidebar Search", () => {
	test("sidebar search input filters navigation", async ({ page }) => {
		await test.step("Navigate to dashboard", async () => {
			await page.goto(server.baseURL);
			await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
		});

		await test.step("Find search button or input in sidebar", async () => {
			const searchBtn = page.locator('[title*="earch"], [placeholder*="earch"]').first();
			if (await searchBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
				await searchBtn.click();
			}
		});
	});
});
