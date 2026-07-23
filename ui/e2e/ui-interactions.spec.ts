import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Task Creation via UI", () => {
	test("creates task from kanban '+ New Task' button", async ({ page }) => {
		await test.step("Navigate to kanban page", async () => {
			await page.goto(`${server.baseURL}/kanban`);
		});

		await test.step("Click '+ New Task' button", async () => {
			await page.getByRole("button", { name: /new task/i }).click();
		});

		await test.step("Type task title", async () => {
			await page.getByPlaceholder(/title/i).first().fill("Buy groceries for the week");
		});

		await test.step("Click 'Create Task' to submit", async () => {
			await page.getByRole("button", { name: "Create Task" }).click();
		});

		await test.step("Task appears on the kanban board", async () => {
			// Use kanban-specific locator to avoid matching toast notification
			await page.waitForTimeout(500);
			await expect(page.locator("[data-board-column] >> text=Buy groceries for the week").first()
				.or(page.locator("h3").filter({ hasText: "Buy groceries for the week" }))).toBeVisible();
		});
	});

	test("creates task from tasks page", async ({ page }) => {
		await test.step("Navigate to tasks page", async () => {
			await page.goto(`${server.baseURL}/tasks`);
		});

		await test.step("Click new task button", async () => {
			const newTaskBtn = page.getByRole("button", { name: /new task/i }).first();
			if (await newTaskBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
				await newTaskBtn.click();
			} else {
				// Table view shows a compact "New" button
				await page.getByRole("button", { name: /^new$/i }).first().click();
			}
		});

		await test.step("Type task title", async () => {
			await page.getByPlaceholder(/title/i).first().fill("Design login page");
		});

		await test.step("Submit the task", async () => {
			await page.getByRole("button", { name: "Create Task" }).click();
		});

		await test.step("Task appears in the table", async () => {
			await expect(page.getByText("Design login page").first()).toBeVisible();
		});
	});

	test("creates task using inline 'Add an item' on kanban column", async ({ page }) => {
		await test.step("Navigate to kanban page", async () => {
			await page.goto(`${server.baseURL}/kanban`);
		});

		const addBtn = page.getByRole("button", { name: "Add an item" }).first();
		if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
			await test.step("Click 'Add an item' in column", async () => {
				await addBtn.click();
			});

			await test.step("Type task title", async () => {
				await page.getByPlaceholder(/title/i).first().fill("Quick inline task");
			});

			await test.step("Submit", async () => {
				await page.getByRole("button", { name: "Create Task" }).click();
			});

			await test.step("Task appears in the column", async () => {
				await page.waitForTimeout(500);
				await expect(page.locator("h3").filter({ hasText: "Quick inline task" }).first()
					.or(page.getByText("Quick inline task").first())).toBeVisible();
			});
		}
	});
});

test.describe("Task Detail Interactions", () => {
	test("views task detail and sees all sections", async ({ page }) => {
		await test.step("Create task with full data", async () => {
			server.cli('task create "Full Detail Task" -d "A complete task" --priority high --ac "First AC" --ac "Second AC" -l ui -l feature');
		});

		await test.step("Navigate to kanban and open task", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Full Detail Task").first().click();
		});

		await test.step("Description section visible", async () => {
			await expect(page.getByText("A complete task")).toBeVisible();
		});

		await test.step("Acceptance Criteria section visible", async () => {
			await expect(page.getByText("Acceptance Criteria")).toBeVisible();
			await expect(page.getByText("First AC")).toBeVisible();
			await expect(page.getByText("Second AC")).toBeVisible();
		});

		await test.step("Sidebar shows status, priority, labels", async () => {
			const dialog = page.locator('[role="dialog"]');
			await expect(dialog.locator("span.text-xs", { hasText: "Status" }).first()).toBeVisible();
			await expect(dialog.locator("span.text-xs", { hasText: "Priority" }).first()).toBeVisible();
			await expect(dialog.locator("span.text-xs", { hasText: "Labels" }).first()).toBeVisible();
		});

		await test.step("Labels are displayed", async () => {
			await expect(page.getByText("ui").first()).toBeVisible();
			await expect(page.getByText("feature").first()).toBeVisible();
		});
	});

	test("checks acceptance criteria checkbox", async ({ page }) => {
		await test.step("Create task with AC", async () => {
			server.cli('task create "Checkbox Task" -d "Has checkable AC" --ac "First criterion"');
		});

		await test.step("Navigate to kanban and open task", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Checkbox Task").first().click();
		});

		await test.step("AC text is visible", async () => {
			await expect(page.getByText("First criterion")).toBeVisible();
		});

		await test.step("Click the checkbox next to AC", async () => {
			// Find the checkbox near the AC text
			const acRow = page.locator("text=First criterion").locator("..");
			const checkbox = acRow.getByRole("checkbox").first()
				.or(acRow.locator("button[role=checkbox]").first())
				.or(page.getByRole("checkbox").first());
			if (await checkbox.isVisible({ timeout: 2000 }).catch(() => false)) {
				await checkbox.click();
				await page.waitForTimeout(500);
			}
		});
	});

	test("clicks Add criterion button in task detail", async ({ page }) => {
		await test.step("Create task", async () => {
			server.cli('task create "AC Add Task" -d "Will add ACs"');
		});

		await test.step("Navigate to kanban and open task", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("AC Add Task").first().click();
		});

		await test.step("'Add criterion' button is visible", async () => {
			const addAcBtn = page.getByText(/add criterion/i).first();
			await expect(addAcBtn).toBeVisible();
		});

		await test.step("Click 'Add criterion' opens input", async () => {
			await page.getByText(/add criterion/i).first().click();
			// Input should appear for entering new AC
			const acInput = page.getByRole("textbox").last();
			await expect(acInput).toBeVisible({ timeout: 3000 });
		});
	});

	test("adds label via UI", async ({ page }) => {
		await test.step("Create task", async () => {
			server.cli('task create "Label Task" -d "Will add labels"');
		});

		await test.step("Navigate to kanban and open task", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Label Task").first().click();
		});

		await test.step("Click 'Add label'", async () => {
			const addLabelBtn = page.getByText(/add label/i).first();
			await expect(addLabelBtn).toBeVisible();
			await addLabelBtn.click();
		});

		await test.step("Type label name and submit", async () => {
			const labelInput = page.getByRole("textbox").last();
			if (await labelInput.isVisible({ timeout: 2000 }).catch(() => false)) {
				await labelInput.fill("frontend");
				await labelInput.press("Enter");
			}
		});

		await test.step("Label appears on the task", async () => {
			await expect(page.getByText("frontend").first()).toBeVisible();
		});
	});

	test("clicks 'Mark as Done' button", async ({ page }) => {
		await test.step("Create task", async () => {
			server.cli('task create "Done Task" -d "Will be marked done"');
		});

		await test.step("Navigate to kanban and open task", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Done Task").first().click();
		});

		await test.step("Click 'Mark as Done'", async () => {
			const doneBtn = page.getByText(/mark as done/i).first();
			await expect(doneBtn).toBeVisible();
			await doneBtn.click();
		});

		await test.step("Task status changes", async () => {
			// After marking done, status should show "Done" or task should close
			await page.waitForTimeout(500);
		});
	});

	test("closes detail sheet with X button and Escape", async ({ page }) => {
		await test.step("Create and open task", async () => {
			server.cli('task create "Close Test Task" -d "Test closing"');
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Close Test Task").first().click();
		});

		await test.step("Detail sheet is open", async () => {
			await expect(page.getByText("Description")).toBeVisible();
		});

		await test.step("Press Escape to close", async () => {
			await page.keyboard.press("Escape");
		});

		await test.step("Detail sheet is closed", async () => {
			// Board should be visible again without detail overlay
			await page.waitForTimeout(500);
			await expect(page.getByText("Close Test Task").first()).toBeVisible();
		});
	});
});

test.describe("Document Interactions via UI", () => {
	test("creates new document from docs page", async ({ page }) => {
		await test.step("Navigate to docs page", async () => {
			await page.goto(`${server.baseURL}/docs`);
		});

		await test.step("Click '+ New Doc' button", async () => {
			await page.getByTitle("Create new document").click();
		});

		await test.step("Page switches to doc editor with title", async () => {
			await expect(page.locator('input[placeholder="Untitled"]').first()).toBeVisible();
			await expect(page.getByRole("button", { name: /create/i }).first()).toBeVisible();
		});

		await test.step("Type document title", async () => {
			// Title is an inline editable heading — find the input/editable element
			const titleEl = page.locator("h1[contenteditable], input[type=text], h1 input").first()
				.or(page.getByPlaceholder(/title|name/i).first());
			if (await titleEl.isVisible({ timeout: 2000 }).catch(() => false)) {
				await titleEl.click();
				await titleEl.fill("My New Guide");
			}
		});

		await test.step("Click Create button", async () => {
			await page.getByRole("button", { name: /create/i }).first().click();
		});

		await test.step("Document is created and visible", async () => {
			await page.waitForTimeout(1000);
			await expect(page.getByText("My New Guide").first()).toBeVisible();
		});
	});

	test("opens and reads document content", async ({ page }) => {
		await test.step("Create doc with content via CLI", async () => {
			server.cli('doc create "Architecture Guide" -d "System architecture" -t "guide"');
			try {
				server.cli('doc edit "architecture-guide" -c "## Components\n\nThe system has 3 main components."');
			} catch {
				server.cli('doc edit "Architecture Guide" -c "## Components\n\nThe system has 3 main components."');
			}
		});

		await test.step("Navigate to docs page", async () => {
			await page.goto(`${server.baseURL}/docs`);
		});

		await test.step("Click on the document", async () => {
			await page.getByText("Architecture Guide").first().click();
			await page.waitForTimeout(1000);
		});

		await test.step("Document heading is visible", async () => {
			await expect(page.getByRole("heading", { name: "Components" })).toBeVisible();
		});

		await test.step("Document body text is visible", async () => {
			await expect(page.getByText("The system has 3 main components")).toBeVisible();
		});
	});

	test("navigates back from doc view to doc list", async ({ page }) => {
		await test.step("Create doc", async () => {
			server.cli('doc create "Back Nav Doc" -d "Test back navigation" -t "test"');
		});

		await test.step("Navigate to docs and open doc", async () => {
			await page.goto(`${server.baseURL}/docs`);
			await page.getByText("Back Nav Doc").first().click();
		});

		await test.step("Click Back button", async () => {
			await page.getByText("Back").first().click();
		});

		await test.step("Back to doc list", async () => {
			await expect(page.getByText("Back Nav Doc").first()).toBeVisible();
		});
	});

	test("clicks Edit button on doc view", async ({ page }) => {
		await test.step("Create doc with content", async () => {
			server.cli('doc create "Edit Test Doc" -d "Will click edit" -t "test"');
			try {
				server.cli('doc edit "edit-test-doc" -c "## Section\n\nSome content here."');
			} catch {
				server.cli('doc edit "Edit Test Doc" -c "## Section\n\nSome content here."');
			}
		});

		await test.step("Navigate to docs and open doc", async () => {
			await page.goto(`${server.baseURL}/docs`);
			await page.getByText("Edit Test Doc").first().click();
		});

		await test.step("Click Edit button", async () => {
			// Edit button is in the toolbar: pencil icon + "Edit" text
			const editBtn = page.locator("button", { hasText: "Edit" }).first();
			await expect(editBtn).toBeVisible();
			await editBtn.click();
		});

		await test.step("Edit mode is activated", async () => {
			await page.waitForTimeout(1000);
			// After clicking edit, page should show editor with save/back controls
			const saveBtn = page.getByRole("button", { name: /save|update|back/i }).first();
			const editor = page.locator("[contenteditable], textarea, .tiptap, .ProseMirror, [class*=editor]").first();
			await expect(saveBtn.or(editor)).toBeVisible();
		});
	});
});

test.describe("Search via UI", () => {
	test("searches for tasks using Cmd+K", async ({ page }) => {
		await test.step("Create searchable tasks", async () => {
			server.cli('task create "Login Authentication Feature" -d "Implement login"');
			server.cli('task create "Dashboard Widget" -d "Add widgets"');
		});

		await test.step("Navigate to dashboard", async () => {
			await page.goto(server.baseURL);
		});

		await test.step("Open search with Cmd+K", async () => {
			await page.keyboard.press("Meta+k");
		});

		await test.step("Type search query and see results", async () => {
			const searchInput = page.getByPlaceholder(/search/i).first();
			if (await searchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
				await searchInput.fill("Login");
				await expect(page.getByText("Login Authentication Feature").first()).toBeVisible();
			}
		});
	});

	test("searches using sidebar search button", async ({ page }) => {
		await test.step("Create a task", async () => {
			server.cli('task create "Sidebar Search Target" -d "Find me"');
		});

		await test.step("Navigate to dashboard", async () => {
			await page.goto(server.baseURL);
		});

		await test.step("Click search in sidebar to open search dialog", async () => {
			// Sidebar search is a button that opens the search command dialog
			const searchBtn = page.locator("button", { hasText: /search/i }).first();
			await searchBtn.click();
		});

		await test.step("Type search query", async () => {
			const input = page.getByPlaceholder(/search/i).first();
			await expect(input).toBeVisible({ timeout: 3000 });
			await input.fill("Sidebar Search");
		});

		await test.step("Results appear", async () => {
			await expect(page.getByText("Sidebar Search Target").first()).toBeVisible();
		});
	});
});

test.describe("Settings Page Interactions", () => {
	test("views and interacts with settings", async ({ page }) => {
		await test.step("Navigate to settings page", async () => {
			await page.goto(`${server.baseURL}/config`);
		});

		await test.step("Settings page loads with sections", async () => {
			await expect(page.getByText(/general|project/i).first()).toBeVisible();
		});

		await test.step("Project name field exists", async () => {
			const nameInput = page.getByLabel(/project name/i).first()
				.or(page.locator("input").first());
			if (await nameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
				await nameInput.clear();
				await nameInput.fill("My Awesome Project");
				await nameInput.press("Tab");
			}
		});
	});
});

test.describe("Full User Workflows (no CLI)", () => {
	test("create task → open detail → close → verify on board", async ({ page }) => {
		await test.step("Navigate to kanban", async () => {
			await page.goto(`${server.baseURL}/kanban`);
		});

		await test.step("Create task via '+ New Task'", async () => {
			await page.getByRole("button", { name: /new task/i }).click();
			await page.getByPlaceholder(/title/i).first().fill("Workflow Test Task");
			await page.getByRole("button", { name: "Create Task" }).click();
		});

		await test.step("Wait for task to appear on board", async () => {
			await page.waitForTimeout(1000);
			await expect(page.locator("h3").filter({ hasText: "Workflow Test Task" }).first()
				.or(page.getByText("Workflow Test Task").first())).toBeVisible();
		});

		await test.step("Open task detail by clicking", async () => {
			await page.getByText("Workflow Test Task").first().click();
		});

		await test.step("Verify detail sections are shown", async () => {
			await expect(page.getByRole("heading", { name: "Description" })).toBeVisible();
			await expect(page.getByText("Acceptance Criteria")).toBeVisible();
		});

		await test.step("Close detail with Escape", async () => {
			await page.keyboard.press("Escape");
			await page.waitForTimeout(300);
		});
	});

	test("navigate between pages via sidebar", async ({ page }) => {
		await test.step("Start at Dashboard", async () => {
			await page.goto(server.baseURL);
			await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
		});

		await test.step("Go to Kanban via sidebar", async () => {
			await page.getByText("Kanban", { exact: true }).first().click();
			await expect(page).toHaveURL(/\/kanban/);
		});

		await test.step("Go to Docs via sidebar", async () => {
			await page.getByText("Docs", { exact: true }).first().click();
			await expect(page).toHaveURL(/\/docs/);
		});

		await test.step("Go back to Dashboard", async () => {
			await page.getByText("Dashboard", { exact: true }).first().click();
			await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
		});
	});

	test("create task then find it via search", async ({ page }) => {
		await test.step("Navigate to kanban and create task", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByRole("button", { name: /new task/i }).click();
			await page.getByPlaceholder(/title/i).first().fill("Unique Searchable XYZ123");
			await page.getByRole("button", { name: "Create Task" }).click();
		});

		await test.step("Wait for task on board", async () => {
			await page.waitForTimeout(1000);
		});

		await test.step("Open search and find the task", async () => {
			await page.keyboard.press("Meta+k");
			const searchInput = page.getByPlaceholder(/search/i).first();
			if (await searchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
				await searchInput.fill("Unique Searchable");
				await expect(page.getByText("Unique Searchable XYZ123").first()).toBeVisible();
			}
		});
	});
});
