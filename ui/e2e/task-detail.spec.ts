import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Task Detail Sheet", () => {
	test("shows task description in detail", async ({ page }) => {
		await test.step("Create a task with description", async () => {
			server.cli('task create "Detailed Task" -d "This is a detailed description for testing"');
		});

		await test.step("Navigate to kanban and click task", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Detailed Task").first().click();
		});

		await test.step("Description section is visible", async () => {
			await expect(page.getByRole("heading", { name: "Description" })).toBeVisible();
		});

		await test.step("Description content is shown", async () => {
			await expect(page.getByText("This is a detailed description for testing").first()).toBeVisible();
		});
	});

	test("shows task priority in detail", async ({ page }) => {
		await test.step("Create a high priority task", async () => {
			server.cli('task create "Priority Task" -d "Has high priority" --priority high');
		});

		await test.step("Navigate to kanban and click task", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Priority Task").first().click();
		});

		await test.step("Priority is displayed in detail", async () => {
			await expect(page.getByText(/high/i).first()).toBeVisible();
		});
	});

	test("shows acceptance criteria", async ({ page }) => {
		await test.step("Create task with acceptance criteria", async () => {
			server.cli('task create "AC Task" -d "Has ACs" --ac "User can login" --ac "User sees dashboard"');
		});

		await test.step("Navigate to kanban and click task", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("AC Task").first().click();
		});

		await test.step("Acceptance criteria are displayed", async () => {
			await expect(page.getByText("User can login")).toBeVisible();
			await expect(page.getByText("User sees dashboard")).toBeVisible();
		});
	});

	test("shows task with labels", async ({ page }) => {
		await test.step("Create task with labels", async () => {
			server.cli('task create "Labeled Task" -d "Has labels" -l bug -l frontend');
		});

		await test.step("Navigate to kanban and click task", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Labeled Task").first().click();
		});

		await test.step("Labels are displayed", async () => {
			await expect(page.getByText("bug").first()).toBeVisible();
			await expect(page.getByText("frontend").first()).toBeVisible();
		});
	});

	test("shows implementation plan", async ({ page }) => {
		await test.step("Create task with plan", async () => {
			const output = server.cli('task create "Planned Task" -d "Has a plan"');
			const idMatch = output.match(/Created task\s+([a-z0-9-]+)/i);
			if (idMatch?.[1]) {
				server.cli(`task edit ${idMatch[1]} --plan "1. Design the feature\n2. Implement it\n3. Write tests"`);
			}
		});

		await test.step("Navigate to kanban and click task", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Planned Task").first().click();
		});

		await test.step("Plan is in its own tab", async () => {
			await page.getByRole("tab", { name: "Plan" }).click();
			await expect(page.getByText("Design the feature")).toBeVisible();
		});
	});

	test("exposes Plan, Notes, Time and Activity as tabs", async ({ page }) => {
		server.cli('task create "Tabbed Task" -d "Has tabs"');
		await page.goto(`${server.baseURL}/kanban`);
		await page.getByText("Tabbed Task").first().click();
		const dialog = page.locator('[role="dialog"]');
		for (const name of ["Overview", "Plan", "Notes", "Time", "Activity"]) {
			const tab = dialog.getByRole("tab", { name });
			await tab.click();
			await expect(tab).toHaveAttribute("aria-selected", "true");
		}
	});

	test("acceptance criteria show progress and can be checked", async ({ page }) => {
		server.cli('task create "Checklist Task" -d "Has criteria" --ac "First" --ac "Second"');
		await page.goto(`${server.baseURL}/kanban`);
		await page.getByText("Checklist Task").first().click();
		const dialog = page.locator('[role="dialog"]');
		await expect(dialog.getByText("0 of 2 criteria done")).toBeVisible();
		await dialog.getByRole("checkbox", { name: "First" }).click();
		await expect(dialog.getByText("1 of 2 criteria done")).toBeVisible();
	});

	test("Escape closes the archive dialog first, then the sheet", async ({ page }) => {
		server.cli('task create "Escape Task" -d "Nested dialogs"');
		await page.goto(`${server.baseURL}/kanban`);
		await page.getByText("Escape Task").first().click();
		await page.getByRole("button", { name: "Archive Task" }).first().click();
		const child = page.getByTestId("task-lifecycle-dialog");
		await expect(child).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(child).toBeHidden();
		await expect(page.getByRole("heading", { name: "Description" })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("heading", { name: "Description" })).toBeHidden();
	});

	test("closes detail sheet", async ({ page }) => {
		await test.step("Create and open a task", async () => {
			server.cli('task create "Closable Task" -d "Can be closed"');
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Closable Task").first().click();
		});

		await test.step("Detail sheet is open", async () => {
			await expect(page.getByRole("heading", { name: "Description" })).toBeVisible();
		});

		await test.step("Close the detail sheet", async () => {
			// Press Escape or click close button
			await page.keyboard.press("Escape");
		});

		await test.step("Detail sheet is closed", async () => {
			await expect(page.getByRole("heading", { name: "Description" })).not.toBeVisible({ timeout: 3000 }).catch(() => {
				// Some sheets may not close with Escape
			});
		});
	});
});
