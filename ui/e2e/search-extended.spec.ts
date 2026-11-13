import { test, expect, type Page } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
	// Seed tasks and docs for search tests
	server.cli('task create "Search Auth Module" -d "Implement JWT authentication with refresh tokens" --priority high -l "auth"');
	server.cli('task create "Search Login UI" -d "Design and implement the login page with email/password form" --priority medium -l "frontend"');
	server.cli('task create "Search API Integration" -d "Integrate backend REST API for user management" --priority medium -l "backend"');
	server.cli('doc create "Search Auth Guide" -d "Authentication guide for developers using Knowns" -t auth -t guide');
	server.cli('doc create "Search API Reference" -d "Complete API reference for all endpoints" -t api');
});

test.afterAll(() => {
	server?.cleanup();
});

const dialog = (page: Page) => page.getByRole("dialog", { name: "Search", exact: true });
const input = (page: Page) => dialog(page).getByRole("combobox", { name: "Search commands" });
const group = (page: Page, name: string) => dialog(page).getByRole("group", { name, exact: true });

/** Go to a page once the app has loaded, then open the menu with the platform shortcut (Ctrl+K, ⌘K on macOS). */
async function openSearch(page: Page, path = "/kanban") {
	await page.goto(`${server.baseURL}${path}`);
	await expect(page.getByRole("button", { name: /^Search\.\.\./ })).toBeVisible();
	await page.keyboard.press("ControlOrMeta+k");
	await expect(input(page)).toBeVisible();
}

test.describe("Search Command Dialog (Cmd+K)", () => {
	test("opens with the platform shortcut and shows search input", async ({ page }) => {
		await test.step("Open search dialog", async () => {
			await openSearch(page);
		});

		await test.step("Search input is focused", async () => {
			await expect(input(page)).toBeFocused();
			await expect(input(page)).toHaveValue("");
		});

		await test.step("Initial state lists pages and actions", async () => {
			await expect(group(page, "Pages").getByRole("option", { name: "Dashboard" })).toBeVisible();
			await expect(group(page, "Actions").getByRole("option", { name: "New task" })).toBeVisible();
			await expect(group(page, "Tasks")).toHaveCount(0);
		});

		await test.step("Cleanup", async () => {
			await page.keyboard.press("Escape");
		});
	});

	test("opens with Ctrl+K on non-mac", async ({ page }) => {
		test.skip(process.platform === "darwin", "macOS uses ⌘K");

		await test.step("Navigate to kanban", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await expect(page.getByRole("button", { name: /^Search\.\.\./ })).toBeVisible();
		});

		await test.step("Open with Ctrl+K", async () => {
			await page.keyboard.press("Control+k");
		});

		await test.step("Dialog is visible", async () => {
			await expect(input(page)).toBeVisible();
		});

		await test.step("Cleanup", async () => {
			await page.keyboard.press("Escape");
		});
	});

	test("toggles dialog with the shortcut", async ({ page }) => {
		await test.step("Open then close with same shortcut", async () => {
			await openSearch(page);
			await page.keyboard.press("ControlOrMeta+k");
			await expect(dialog(page)).toBeHidden();
		});
	});

	test("search finds tasks by title", async ({ page }) => {
		await test.step("Open search", async () => {
			await openSearch(page);
		});

		await test.step("Search for 'Auth'", async () => {
			await input(page).fill("Auth");
		});

		await test.step("Matching task result visible in the Tasks group", async () => {
			await expect(group(page, "Tasks").getByRole("option", { name: /Search Auth Module/ })).toBeVisible();
		});

		await test.step("Status badge shown on result", async () => {
			await expect(group(page, "Tasks").getByRole("option", { name: /Search Auth Module/ }).getByText("To Do")).toBeVisible();
		});

		await test.step("Cleanup", async () => {
			await page.keyboard.press("Escape");
		});
	});

	test("search finds tasks by description content", async ({ page }) => {
		await test.step("Open search", async () => {
			await openSearch(page);
		});

		await test.step("Search for description content", async () => {
			await input(page).fill("refresh tokens");
		});

		await test.step("Task with matching description appears", async () => {
			await expect(dialog(page).getByRole("option", { name: /Search Auth Module/ })).toBeVisible();
		});

		await test.step("Cleanup", async () => {
			await page.keyboard.press("Escape");
		});
	});

	test("search finds docs", async ({ page }) => {
		await test.step("Open search", async () => {
			await openSearch(page);
		});

		await test.step("Search for doc", async () => {
			await input(page).fill("API Reference");
		});

		await test.step("Doc result appears in the Docs group", async () => {
			await expect(group(page, "Docs").getByRole("option", { name: /Search API Reference/ })).toBeVisible();
		});

		await test.step("Cleanup", async () => {
			await page.keyboard.press("Escape");
		});
	});

	test("search shows both tasks and docs in separate groups", async ({ page }) => {
		await test.step("Open search", async () => {
			await openSearch(page);
		});

		await test.step("Search for term matching both", async () => {
			await input(page).fill("Search");
		});

		await test.step("Both groups appear", async () => {
			await expect(group(page, "Tasks").getByRole("option").first()).toBeVisible();
			await expect(group(page, "Docs").getByRole("option").first()).toBeVisible();
		});

		await test.step("Cleanup", async () => {
			await page.keyboard.press("Escape");
		});
	});

	test("empty search after typing shows no results", async ({ page }) => {
		await test.step("Open search", async () => {
			await openSearch(page);
		});

		await test.step("Search for non-existent term", async () => {
			await input(page).fill("zzznonexistenttask999");
		});

		await test.step("No results message shown", async () => {
			await expect(dialog(page).getByText("No tasks, docs or pages match “zzznonexistenttask999”")).toBeVisible();
			await expect(dialog(page).getByRole("option")).toHaveCount(0);
		});

		await test.step("Cleanup", async () => {
			await page.keyboard.press("Escape");
		});
	});

	test("clearing search input resets to the initial list", async ({ page }) => {
		await test.step("Open search", async () => {
			await openSearch(page);
		});

		await test.step("Type then clear search", async () => {
			await input(page).fill("Auth");
			await expect(group(page, "Tasks").getByRole("option", { name: /Search Auth Module/ })).toBeVisible();
			await input(page).fill("");
		});

		await test.step("Initial list returns", async () => {
			await expect(group(page, "Pages").getByRole("option", { name: "Dashboard" })).toBeVisible();
			await expect(group(page, "Tasks")).toHaveCount(0);
		});

		await test.step("Cleanup", async () => {
			await page.keyboard.press("Escape");
		});
	});

	test("clicking task result opens the task", async ({ page }) => {
		await test.step("Open search", async () => {
			await openSearch(page);
		});

		await test.step("Search and click result", async () => {
			await input(page).fill("Login UI");
			const resultItem = dialog(page).getByRole("option", { name: /Search Login UI/ }).first();
			await expect(resultItem).toBeVisible();
			await resultItem.click();
		});

		await test.step("Dialog closes and task detail opens", async () => {
			await expect(dialog(page)).toBeHidden();
			await expect(page.getByRole("heading", { name: "Search Login UI", exact: true })).toBeVisible();
		});
	});

	test("clicking doc result navigates to docs", async ({ page }) => {
		await test.step("Open search", async () => {
			await openSearch(page);
		});

		await test.step("Search and click doc result", async () => {
			await input(page).fill("Auth Guide");
			const resultItem = group(page, "Docs").getByRole("option", { name: /Search Auth Guide/ }).first();
			await expect(resultItem).toBeVisible();
			await resultItem.click();
		});

		await test.step("Docs page opens", async () => {
			await expect(dialog(page)).toBeHidden();
			await expect(page).toHaveURL(/\/docs/);
		});
	});

	test("picked results show under Recent next time", async ({ page }) => {
		await test.step("Pick a task", async () => {
			await openSearch(page);
			await input(page).fill("API Integration");
			await dialog(page).getByRole("option", { name: /Search API Integration/ }).first().click();
			await expect(dialog(page)).toBeHidden();
		});

		await test.step("Reopen with an empty query", async () => {
			await page.keyboard.press("Escape");
			await page.keyboard.press("ControlOrMeta+k");
			await expect(input(page)).toBeVisible();
			await expect(group(page, "Recent").getByRole("option", { name: /Search API Integration/ })).toBeVisible();
		});

		await test.step("Cleanup", async () => {
			await page.keyboard.press("Escape");
		});
	});

	test("dialog closes on Escape", async ({ page }) => {
		await test.step("Open search", async () => {
			await openSearch(page);
		});

		await test.step("Type a search", async () => {
			await input(page).fill("test");
		});

		await test.step("Press Escape to close", async () => {
			await page.keyboard.press("Escape");
		});

		await test.step("Dialog is gone", async () => {
			await expect(dialog(page)).toBeHidden();
		});
	});

	test("search from dashboard page", async ({ page }) => {
		await test.step("Open search from dashboard", async () => {
			await openSearch(page, "/");
		});

		await test.step("Search works", async () => {
			await input(page).fill("Auth");
			await expect(dialog(page).getByRole("option", { name: /Search Auth Module/ })).toBeVisible();
		});

		await test.step("Cleanup", async () => {
			await page.keyboard.press("Escape");
		});
	});

	test("newly created task appears in search", async ({ page }) => {
		await test.step("Create fresh task", async () => {
			server.cli('task create "Search Fresh Task" -d "Created during test"');
		});

		await test.step("Open search", async () => {
			await openSearch(page);
		});

		await test.step("Fresh task appears in results", async () => {
			await input(page).fill("Fresh Task");
			await expect(dialog(page).getByRole("option", { name: /Search Fresh Task/ })).toBeVisible();
		});

		await test.step("Cleanup", async () => {
			await page.keyboard.press("Escape");
		});
	});

	test("task ID shown in search result", async ({ page }) => {
		await test.step("Open search", async () => {
			await openSearch(page);
		});

		await test.step("Search", async () => {
			await input(page).fill("API Integration");
		});

		await test.step("Task ID visible in result (e.g., #<id>)", async () => {
			const option = group(page, "Tasks").getByRole("option", { name: /Search API Integration/ });
			await expect(option.getByText(/^#[a-z0-9.-]+$/i)).toBeVisible();
		});

		await test.step("Cleanup", async () => {
			await page.keyboard.press("Escape");
		});
	});

	test("results limit to 8 per group", async ({ page }) => {
		await test.step("Create many tasks with same keyword", async () => {
			for (let i = 0; i < 12; i++) {
				server.cli(`task create "Search Limit ${i}" -d "Task ${i} for limit test"`);
			}
		});

		await test.step("Open search", async () => {
			await openSearch(page);
		});

		await test.step("Search for limit keyword", async () => {
			await input(page).fill("Search Limit");
		});

		await test.step("Task results are capped at 8", async () => {
			const tasks = group(page, "Tasks").getByRole("option");
			await expect(tasks.first()).toBeVisible();
			await expect(tasks).toHaveCount(8);
		});

		await test.step("Cleanup", async () => {
			await page.keyboard.press("Escape");
		});
	});
});
