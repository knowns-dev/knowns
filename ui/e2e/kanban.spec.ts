import { test, expect } from "@playwright/test";
import { boardCard, boardColumn, startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Kanban Board", () => {
	test("shows board columns", async ({ page }) => {
		await test.step("Navigate to kanban page", async () => {
			await page.goto(`${server.baseURL}/kanban`);
		});

		await test.step("Shared page header is visible", async () => {
			// /kanban is now the unified Tasks page pinned to board view.
			await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
			await expect(page.getByRole("button", { name: "Board view" })).toHaveAttribute(
				"aria-pressed",
				"true",
			);
		});

		await test.step("Board columns are rendered", async () => {
			await expect(page.getByRole("region", { name: "Task board" })).toBeVisible();
			for (const name of ["To Do", "In Progress", "Done"]) {
				await expect(page.getByRole("heading", { level: 3, name, exact: true })).toBeVisible();
			}
			await expect(boardColumn(page, "todo").first()).toBeVisible();
		});
	});

	test("displays tasks created via CLI", async ({ page }) => {
		await test.step("Create task via CLI", async () => {
			server.cli('task create "Kanban Visible Task" -d "Should appear on board"');
		});

		await test.step("Navigate to kanban page", async () => {
			await page.goto(`${server.baseURL}/kanban`);
		});

		await test.step("Task is visible in the To Do column", async () => {
			await expect(boardCard(boardColumn(page, "todo"), "Kanban Visible Task")).toBeVisible();
		});
	});

	test("opens task detail on click", async ({ page }) => {
		await test.step("Create task via CLI", async () => {
			server.cli('task create "Clickable Task" -d "Click to see details"');
		});

		await test.step("Navigate to kanban page", async () => {
			await page.goto(`${server.baseURL}/kanban`);
		});

		await test.step("Click the task card", async () => {
			await boardCard(page, "Clickable Task").click();
		});

		await test.step("Task detail sheet opens with description", async () => {
			await expect(page.getByRole("heading", { name: "Description" })).toBeVisible();
		});
	});

	test("can create task from board UI", async ({ page }) => {
		await test.step("Navigate to kanban page", async () => {
			await page.goto(`${server.baseURL}/kanban`);
		});

		await test.step("Open 'Add card' in the To Do column", async () => {
			await boardColumn(page, "todo").first().getByRole("button", { name: "Add card" }).click();
		});

		await test.step("Type the title and press Enter", async () => {
			const input = page.getByRole("textbox", { name: "New card in To Do" });
			await input.fill("Board Created Task");
			await input.press("Enter");
		});

		await test.step("New task appears in the To Do column", async () => {
			await expect(boardCard(boardColumn(page, "todo"), "Board Created Task")).toBeVisible();
		});
	});

	test("hides and shows a column", async ({ page }) => {
		await test.step("Navigate to kanban page", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await expect(boardColumn(page, "blocked").first()).toBeVisible();
		});

		const toggle = page.getByRole("group", { name: "Visible columns" }).getByRole("button", { name: /^Blocked/ });

		await test.step("Hide Blocked", async () => {
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-pressed", "false");
			await expect(boardColumn(page, "blocked")).toHaveCount(0);
		});

		await test.step("Choice survives a reload", async () => {
			await page.reload();
			await expect(boardColumn(page, "todo").first()).toBeVisible();
			await expect(boardColumn(page, "blocked")).toHaveCount(0);
		});

		await test.step("Show Blocked again", async () => {
			await toggle.click();
			await expect(boardColumn(page, "blocked").first()).toBeVisible();
		});
	});

	test("swimlanes per assignee", async ({ page }) => {
		await test.step("Create an assigned task", async () => {
			server.cli('task create "Lane Task" -a @alice');
		});

		await test.step("Navigate to kanban and group by assignee", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByRole("radio", { name: "Assignee" }).click();
		});

		await test.step("The card sits in alice's To Do lane", async () => {
			await expect(boardCard(page.getByRole("group", { name: "To Do, alice" }), "Lane Task")).toBeVisible();
		});
	});
});
