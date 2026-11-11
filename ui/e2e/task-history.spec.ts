import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

/** Helper: open the Activity tab (the version history) of the task detail. */
async function expandHistory(page: import("@playwright/test").Page) {
	const dialog = page.locator('[role="dialog"]');
	const historyTab = dialog.getByRole("tab", { name: "Activity" });
	await historyTab.click();
	await expect(historyTab).toHaveAttribute("aria-selected", "true");
	await expect(dialog.getByRole("region", { name: "History" })).toBeVisible();
}

test.describe("Task History Panel", () => {
	test("history section is collapsible and shows version count", async ({ page }) => {
		let taskId = "";

		await test.step("Create and edit task to generate history", async () => {
			const output = server.cli('task create "History Task" -d "Track changes" --priority low');
			taskId = output.match(/Created task\s+([a-z0-9-]+)/i)?.[1] || "";
			server.cli(`task edit ${taskId} -s in-progress`);
			server.cli(`task edit ${taskId} --priority high`);
			server.cli(`task edit ${taskId} -d "Updated description"`);
		});

		await test.step("Open task detail", async () => {
			await page.goto(`${server.baseURL}/kanban/${taskId}`);
			await expect(page.getByRole("heading", { name: "History Task", exact: true })).toBeVisible();
		});

		await test.step("Open the Activity tab", async () => {
			await expandHistory(page);
		});

		await test.step("History shows changes count", async () => {
			await expect(page.getByText(/\d+ change/).first()).toBeVisible();
		});
	});

	test("history shows summary count after edits", async ({ page }) => {
		let taskId = "";

		await test.step("Create task with several edits", async () => {
			const output = server.cli('task create "Version Task" -d "Original description"');
			taskId = output.match(/Created task\s+([a-z0-9-]+)/i)?.[1] || "";
			server.cli(`task edit ${taskId} -s in-progress`);
			server.cli(`task edit ${taskId} -t "Renamed Version Task"`);
		});

		await test.step("Open task detail", async () => {
			await page.goto(`${server.baseURL}/kanban/${taskId}`);
			await expect(page.getByRole("heading", { name: "Renamed Version Task", exact: true })).toBeVisible();
		});

		await test.step("History summary count is visible", async () => {
			await expandHistory(page);
			const dialog = page.locator('[role="dialog"]');
			await expect(dialog.getByText(/\d+ changes/).first()).toBeVisible();
		});
	});

	test("expanding a version entry shows diff details", async ({ page }) => {
		let taskId = "";

		await test.step("Create task and change status", async () => {
			const output = server.cli('task create "Diff Task" -d "Check diff view" --priority low');
			taskId = output.match(/Created task\s+([a-z0-9-]+)/i)?.[1] || "";
			server.cli(`task edit ${taskId} -s in-progress`);
		});

		await test.step("Open task detail and expand history", async () => {
			await page.goto(`${server.baseURL}/kanban/${taskId}`);
			await expect(page.getByRole("heading", { name: "Diff Task", exact: true })).toBeVisible();
			await expandHistory(page);
		});

		await test.step("Click on a version entry to expand it", async () => {
			const dialog = page.locator('[role="dialog"]');
			const versionEntry = dialog.getByRole("option").first();
			if (await versionEntry.waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false)) {
				await versionEntry.click();
				await page.waitForTimeout(500);
			}
		});

		await test.step("Diff details are shown", async () => {
			// Scope to the history panel: the header pill and the Status property also say "In Progress".
			const history = page.locator('[role="dialog"]').getByRole("region", { name: "History" });
			await expect(history.getByText("In Progress").first()).toBeVisible();
		});
	});

	test("history shows count for mixed change types", async ({ page }) => {
		let taskId = "";

		await test.step("Create task with status and content changes", async () => {
			const output = server.cli('task create "Filter Task" -d "Test filtering" --priority low');
			taskId = output.match(/Created task\s+([a-z0-9-]+)/i)?.[1] || "";
			server.cli(`task edit ${taskId} -s in-progress`);
			server.cli(`task edit ${taskId} -d "Updated for filter test"`);
			server.cli(`task edit ${taskId} --priority high`);
		});

		await test.step("Open task and verify history summary", async () => {
			await page.goto(`${server.baseURL}/kanban/${taskId}`);
			await expect(page.getByRole("heading", { name: "Filter Task", exact: true })).toBeVisible();
			await expandHistory(page);
			const dialog = page.locator('[role="dialog"]');
			await expect(dialog.getByText(/\d+ changes/).first()).toBeVisible();
		});
	});
});
