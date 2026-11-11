import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

// KN-4WADRK: the bell is a notification center over task activity, and the dashboard shows the same
// activity as a feed. Read state lives in this browser only: anything older than the first visit is read.

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

function createTask(title: string): string {
	const out = server.cli(`task create "${title}" -a @owner`);
	const id = out.match(/([A-Z]{2,8}-[0-9A-Z]{6})/)?.[1];
	if (!id) throw new Error(`no task id in: ${out}`);
	return id;
}

test.describe("Notifications and activity", () => {
	test("new agent activity is unread, shows its actor, and can be marked read", async ({ page }) => {
		await page.goto(server.baseURL);
		await expect(page.getByRole("button", { name: /^Notifications$/ })).toBeVisible();

		// After the first visit set the baseline: this arrives later, so it is unread.
		const id = createTask("Agent Edited Task");
		server.mcp("tasks", { action: "update", taskId: id, status: "in-progress" }, "claude-code");
		await page.reload();

		const bell = page.getByRole("button", { name: /^Notifications, / });
		await expect(bell).toBeVisible({ timeout: 15000 });
		await bell.click();

		const panel = page.getByRole("dialog", { name: "Notifications" });
		await expect(panel.getByText(/Claude Code started working on/).first()).toBeVisible();
		await panel.getByRole("tab", { name: /Agents/ }).click();
		await expect(panel.getByText(/Claude Code started working on/).first()).toBeVisible();

		await panel.getByRole("tab", { name: /^All/ }).click();
		await panel.getByRole("button", { name: /mark all .*read/i }).click();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("button", { name: /^Notifications$/ })).toBeVisible();
	});

	test("the dashboard feed lists activity and opens the task", async ({ page }) => {
		const id = createTask("Feed Opens Task");
		server.cli(`task edit ${id} -s done`);
		await page.goto(server.baseURL);

		const feed = page.locator('section[aria-label="Recent activity"]');
		await expect(page.getByRole("heading", { name: "Recent activity", exact: true })).toBeVisible();
		await expect(feed.getByText(/Feed Opens Task/).first()).toBeVisible();
		// A row expands first; the Open button inside it goes to the Task.
		await feed.getByText(/Feed Opens Task/).first().click();
		await feed.getByRole("button", { name: /^Open #.*Feed Opens Task/ }).click();
		await expect(page).toHaveURL(new RegExp(`/tasks/${id}`));
	});
});
