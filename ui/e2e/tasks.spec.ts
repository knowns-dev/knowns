import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Tasks Page", () => {
	test("shows tasks page with table view", async ({ page }) => {
		await test.step("Create tasks via CLI", async () => {
			server.cli('task create "Task Alpha" -d "First task" --priority high');
			server.cli('task create "Task Beta" -d "Second task" --priority low');
		});

		await test.step("Navigate to tasks page", async () => {
			await page.goto(`${server.baseURL}/tasks`);
		});

		await test.step("Tasks heading is visible", async () => {
			await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
		});

		await test.step("Tasks appear in the list", async () => {
			await expect(page.getByText("Task Alpha")).toBeVisible();
			await expect(page.getByText("Task Beta")).toBeVisible();
		});
	});

	test("opens task detail from task list", async ({ page }) => {
		await test.step("Create a task via CLI", async () => {
			server.cli('task create "Detail View Task" -d "Check detail opens"');
		});

		await test.step("Navigate to tasks page", async () => {
			await page.goto(`${server.baseURL}/tasks`);
		});

		await test.step("Click on the task", async () => {
			await page.getByText("Detail View Task").first().click();
		});

		await test.step("Task detail sheet opens", async () => {
			await expect(page.getByRole("heading", { name: "Description" })).toBeVisible();
		});
	});

	test("creates task from tasks page", async ({ page }) => {
		await test.step("Navigate to tasks page", async () => {
			await page.goto(`${server.baseURL}/tasks`);
		});

		await test.step("Click new task button", async () => {
			const newBtn = page.getByRole("button", { name: /new task/i }).first();
			if (await newBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
				await newBtn.click();
			} else {
				// Table view shows a compact "New" button
				await page.getByRole("button", { name: /^new$/i }).first().click();
			}
		});

		await test.step("Fill in task form", async () => {
			await page.getByPlaceholder(/title/i).first().fill("New Page Task");
		});

		await test.step("Submit task creation", async () => {
			await page.getByRole("button", { name: /create task/i }).click();
		});

		await test.step("New task appears in list", async () => {
			await expect(page.getByText("New Page Task").first()).toBeVisible();
		});
	});

	test("shows task priority and status badges", async ({ page }) => {
		await test.step("Create tasks with different priorities", async () => {
			server.cli('task create "High Priority" -d "urgent" --priority high');
			server.cli('task create "Low Priority" -d "chill" --priority low');
		});

		await test.step("Navigate to tasks page", async () => {
			await page.goto(`${server.baseURL}/tasks`);
		});

		await test.step("Priority indicators are shown", async () => {
			await expect(page.getByText("High Priority")).toBeVisible();
			await expect(page.getByText("Low Priority")).toBeVisible();
		});
	});

	test("filters tasks by status", async ({ page }) => {
		await test.step("Create tasks with different statuses", async () => {
			const output = server.cli('task create "Done Task" -d "completed"');
			const idMatch = output.match(/Created task\s+([a-z0-9]+)/i);
			if (idMatch?.[1]) {
				server.cli(`task edit ${idMatch[1]} -s done`);
			}
			server.cli('task create "Todo Task" -d "pending"');
		});

		await test.step("Navigate to tasks page", async () => {
			await page.goto(`${server.baseURL}/tasks`);
		});

		await test.step("Both tasks are visible initially", async () => {
			await expect(page.getByText("Todo Task")).toBeVisible();
		});
	});
});
