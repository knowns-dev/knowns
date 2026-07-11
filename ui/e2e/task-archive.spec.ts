import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Task Archive", () => {
	test("archive button visible in task detail", async ({ page }) => {
		let taskId = "";

		await test.step("Create task", async () => {
			const output = server.cli('task create "Archive Target" -d "Task to be archived" --priority low');
			taskId = output.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
		});

		await test.step("Open task detail", async () => {
			await page.goto(`${server.baseURL}/kanban/${taskId}`);
			await expect(page.getByRole("heading", { name: "Archive Target", exact: true })).toBeVisible();
		});

		await test.step("Archive Task button is visible", async () => {
			const archiveBtn = page.getByText("Archive Task").first();
			await archiveBtn.scrollIntoViewIfNeeded();
			await expect(archiveBtn).toBeVisible();
		});
	});

	test("archiving task removes it from kanban board", async ({ page }) => {
		let taskId = "";

		await test.step("Create task", async () => {
			const output = server.cli('task create "Soon Archived" -d "Will be archived"');
			taskId = output.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
		});

		await test.step("Verify task visible on kanban", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await expect(page.getByText("Soon Archived").first()).toBeVisible();
		});

		await test.step("Archive via CLI", async () => {
			server.cli(`task archive ${taskId}`);
		});

		await test.step("Reload and verify task gone from kanban", async () => {
			await page.reload();
			await page.waitForTimeout(1000);
			const taskCount = await page.getByText("Soon Archived").count();
			expect(taskCount).toBe(0);
		});
	});

	test("unarchiving task brings it back to kanban", async ({ page }) => {
		let taskId = "";

		await test.step("Create and archive task", async () => {
			const output = server.cli('task create "Revived Task" -d "Will be unarchived"');
			taskId = output.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
			server.cli(`task archive ${taskId}`);
		});

		await test.step("Verify task NOT on kanban", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.waitForTimeout(1000);
			const taskCount = await page.getByText("Revived Task").count();
			expect(taskCount).toBe(0);
		});

		await test.step("Unarchive via CLI", async () => {
			server.cli(`task unarchive ${taskId}`);
		});

		await test.step("Reload and verify task is back on kanban", async () => {
			await page.reload();
			await page.waitForTimeout(1000);
			await expect(page.getByText("Revived Task").first()).toBeVisible();
		});
	});

	test("archived task not shown in tasks page", async ({ page }) => {
		let taskId = "";

		await test.step("Create task", async () => {
			const output = server.cli('task create "Hidden Task" -d "Should not appear after archive"');
			taskId = output.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
		});

		await test.step("Verify task on tasks page", async () => {
			await page.goto(`${server.baseURL}/tasks`);
			await expect(page.getByText("Hidden Task").first()).toBeVisible();
		});

		await test.step("Archive and reload", async () => {
			server.cli(`task archive ${taskId}`);
			await page.reload();
			await page.waitForTimeout(1000);
		});

		await test.step("Task gone from tasks page", async () => {
			const taskCount = await page.getByText("Hidden Task").count();
			expect(taskCount).toBe(0);
		});
	});
});

test.describe("Task Delete", () => {
	test("deleted task removed permanently", async ({ page }) => {
		let taskId = "";

		await test.step("Create task", async () => {
			const output = server.cli('task create "Delete Me" -d "Permanent removal"');
			taskId = output.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
		});

		await test.step("Verify task on kanban", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await expect(page.getByText("Delete Me").first()).toBeVisible();
		});

		await test.step("Delete via CLI", async () => {
			server.cli(`task delete ${taskId} --force`);
		});

		await test.step("Reload and verify task gone", async () => {
			await page.reload();
			await page.waitForTimeout(1000);
			const taskCount = await page.getByText("Delete Me").count();
			expect(taskCount).toBe(0);
		});
	});
});
