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

const searchDialog = (page: Page) => page.getByRole("dialog", { name: "Search", exact: true });
const searchInput = (page: Page) => searchDialog(page).getByRole("combobox", { name: "Search commands" });
const sidebarSearchButton = (page: Page) => page.getByRole("button", { name: /^Search\.\.\./ });

async function openSearchDialog(page: Page) {
	await page.goto(`${server.baseURL}/kanban`);
	await expect(sidebarSearchButton(page)).toBeVisible();
	await sidebarSearchButton(page).click();
	await expect(searchInput(page)).toBeVisible();
	await expect(searchInput(page)).toBeFocused();
	return searchInput(page);
}

test.describe("Search Command Dialog", () => {
	test("opens search with Cmd+K and shows results", async ({ page }) => {
		await test.step("Navigate to kanban", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await expect(sidebarSearchButton(page)).toBeVisible();
		});

		await test.step("Open search dialog with Cmd+K", async () => {
			await page.keyboard.press("ControlOrMeta+k");
		});

		await test.step("Search dialog is visible", async () => {
			await expect(searchInput(page)).toBeVisible();
			await expect(searchInput(page)).toHaveAttribute("placeholder", "Search tasks and docs, or jump to a page…");
		});

		await test.step("Type search query", async () => {
			await searchInput(page).fill("Auth");
		});

		await test.step("Results show matching tasks and docs", async () => {
			await expect(searchDialog(page).getByRole("group", { name: "Tasks" }).getByRole("option", { name: /Auth Module/ })).toBeVisible();
			await expect(searchDialog(page).getByRole("group", { name: "Docs" }).getByRole("option", { name: /Auth Guide/ })).toBeVisible();
		});

		await test.step("Close search with Escape", async () => {
			await page.keyboard.press("Escape");
			await expect(searchDialog(page)).toBeHidden();
		});
	});

	test("search finds tasks by description content", async ({ page }) => {
		await test.step("Open search and enter description content", async () => {
			const input = await openSearchDialog(page);
			await input.fill("authentication");
		});

		await test.step("Task with matching description found", async () => {
			await expect(searchDialog(page).getByRole("option", { name: /Auth Module/ })).toBeVisible();
		});

		await test.step("Cleanup", async () => {
			await page.keyboard.press("Escape");
		});
	});

	test("search finds docs", async ({ page }) => {
		await test.step("Open search and enter doc title", async () => {
			const input = await openSearchDialog(page);
			await input.fill("Architecture");
		});

		await test.step("Doc result appears", async () => {
			await expect(searchDialog(page).getByRole("group", { name: "Docs" }).getByRole("option", { name: /Architecture/ })).toBeVisible();
		});

		await test.step("Cleanup", async () => {
			await page.keyboard.press("Escape");
		});
	});

	test("empty search shows no results message", async ({ page }) => {
		await test.step("Open search and enter non-existent term", async () => {
			const input = await openSearchDialog(page);
			await input.fill("zzzznonexistent12345");
		});

		await test.step("No results shown", async () => {
			await expect(searchDialog(page).getByText("No tasks, docs or pages match “zzzznonexistent12345”")).toBeVisible();
			await expect(searchDialog(page).getByRole("option")).toHaveCount(0);
		});

		await test.step("Cleanup", async () => {
			await page.keyboard.press("Escape");
		});
	});

	test("clicking search result navigates to it", async ({ page }) => {
		await test.step("Open search and click a task result", async () => {
			const input = await openSearchDialog(page);
			await input.fill("Login Page");
			const resultItem = searchDialog(page).getByRole("option", { name: /Login Page/ }).first();
			await expect(resultItem).toBeVisible();
			await resultItem.click();
		});

		await test.step("Task detail opens", async () => {
			await expect(searchDialog(page)).toBeHidden();
			await expect(page.getByRole("heading", { name: "Login Page", exact: true })).toBeVisible();
		});
	});
});

test.describe("Sidebar Search", () => {
	test("sidebar search button opens the command menu and jumps to a page", async ({ page }) => {
		await test.step("Navigate to dashboard", async () => {
			await page.goto(server.baseURL);
			await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
		});

		await test.step("Open search from the sidebar", async () => {
			await sidebarSearchButton(page).click();
			await expect(searchInput(page)).toBeVisible();
		});

		await test.step("Pages are listed before typing and filter as you type", async () => {
			await expect(searchDialog(page).getByRole("group", { name: "Pages" }).getByRole("option", { name: "Settings" })).toBeVisible();
			await searchInput(page).fill("Memor");
			await expect(searchDialog(page).getByRole("option", { name: "Memories" })).toBeVisible();
			await expect(searchDialog(page).getByRole("option", { name: "Settings" })).toHaveCount(0);
		});

		await test.step("Choosing a page navigates there", async () => {
			await page.keyboard.press("Enter");
			await expect(searchDialog(page)).toBeHidden();
			await expect(page).toHaveURL(/\/memory$/);
		});
	});
});
