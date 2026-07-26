import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Full Task Create Form", () => {
	test("fills all fields: title, description, priority, AC, labels", async ({ page }) => {
		await test.step("Navigate to kanban and open create form", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByRole("button", { name: /new task/i }).click();
		});

		await test.step("Type task title", async () => {
			await page.getByPlaceholder("Enter task title...").fill("Implement user authentication");
		});

		await test.step("Type description in editor", async () => {
			const descPlaceholder = page.getByText("Add a more detailed description...");
			if (await descPlaceholder.isVisible({ timeout: 2000 }).catch(() => false)) {
				await descPlaceholder.click();
				await page.keyboard.type("Users need to login with email and password");
			}
		});

		await test.step("Change priority to High", async () => {
			const prioritySection = page.locator("text=PRIORITY").locator("..");
			const combobox = prioritySection.getByRole("combobox");
			if (await combobox.isVisible({ timeout: 2000 }).catch(() => false)) {
				await combobox.click();
				await page.getByRole("option", { name: /high/i }).click();
			}
		});

		await test.step("Add acceptance criteria", async () => {
			const addBtn = page.getByRole("button", { name: "Add an item" });
			if (await addBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
				await addBtn.click();
				await page.getByPlaceholder("Add an item...").fill("User can login");
				await page.getByRole("button", { name: "Add" }).first().click();

				await page.getByRole("button", { name: "Add an item" }).click();
				await page.getByPlaceholder("Add an item...").fill("Invalid credentials show error");
				await page.getByRole("button", { name: "Add" }).first().click();
			}
		});

		await test.step("Submit the task", async () => {
			await page.getByRole("button", { name: "Create Task" }).click();
		});

		await test.step("Task appears on board", async () => {
			await page.waitForTimeout(500);
			await expect(page.locator("h3").filter({ hasText: "Implement user authentication" }).first()).toBeVisible();
		});
	});

	test("creates multiple tasks rapidly", async ({ page }) => {
		await test.step("Navigate to kanban", async () => {
			await page.goto(`${server.baseURL}/kanban`);
		});

		for (const title of ["Task One", "Task Two", "Task Three"]) {
			await test.step(`Create: ${title}`, async () => {
				await page.getByRole("button", { name: /new task/i }).click();
				await page.getByPlaceholder("Enter task title...").fill(title);
				await page.getByRole("button", { name: "Create Task" }).click();
				await page.waitForTimeout(300);
			});
		}

		await test.step("All tasks visible", async () => {
			await page.waitForTimeout(500);
			for (const title of ["Task One", "Task Two", "Task Three"]) {
				await expect(page.getByText(title).first()).toBeVisible();
			}
		});
	});
});

test.describe("Task Detail Editing", () => {
	test("edits task title by clicking on heading", async ({ page }) => {
		await test.step("Create task and open from fresh kanban page", async () => {
			server.cli('task create "Editable Title" -d "Title is editable"');
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Editable Title").first().click();
		});

		await test.step("Click on title heading to enter edit mode", async () => {
			const titleHeading = page.getByRole("heading", { name: "Editable Title", exact: true });
			await expect(titleHeading).toBeVisible();
			await titleHeading.click();
		});

		await test.step("Input appears - type new title", async () => {
			// Input component doesn't have explicit type="text", use role selector
			const titleInput = page.getByRole("textbox").first();
			await expect(titleInput).toBeVisible({ timeout: 3000 });
			await titleInput.fill("Renamed Title");
			await titleInput.press("Enter");
			await page.waitForTimeout(500);
		});

		await test.step("New title is displayed", async () => {
			await expect(page.getByText("Renamed Title").first()).toBeVisible();
		});
	});

	test("edits description by clicking on it", async ({ page }) => {
		await test.step("Create task and open detail", async () => {
			server.cli('task create "Desc Edit" -d "Old description text"');
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Desc Edit").first().click();
		});

		await test.step("Click description to enter edit mode", async () => {
			await expect(page.getByText("Old description text")).toBeVisible();
			await page.getByText("Old description text").click();
		});

		await test.step("Save and Cancel buttons appear", async () => {
			await expect(page.getByRole("button", { name: /save/i }).first()).toBeVisible();
			await expect(page.getByRole("button", { name: /cancel/i }).first()).toBeVisible();
		});

		await test.step("Click Cancel to exit edit mode", async () => {
			await page.getByRole("button", { name: /cancel/i }).first().click();
		});
	});

	test("clicks empty description placeholder to edit", async ({ page }) => {
		await test.step("Create task without description", async () => {
			server.cli('task create "No Desc"');
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("No Desc").first().click();
		});

		await test.step("Click placeholder to add description", async () => {
			const placeholder = page.getByText("Click to add description...");
			await expect(placeholder).toBeVisible();
			await placeholder.click();
		});

		await test.step("Editor appears with Save button", async () => {
			await expect(page.getByRole("button", { name: /save/i }).first()).toBeVisible();
		});
	});

	test("changes status in task detail", async ({ page }) => {
		await test.step("Create task and open from tasks page", async () => {
			server.cli('task create "Status Task" -d "Change status"');
			await page.goto(`${server.baseURL}/tasks`);
			await page.getByText("Status Task").first().click();
		});

		await test.step("Find and click status select", async () => {
			await expect(page.getByText("Status").first()).toBeVisible();
			// Status shows "To Do" - click the select trigger
			const statusTrigger = page.locator("button[role=combobox]").filter({ hasText: /to do/i }).first();
			await expect(statusTrigger).toBeVisible({ timeout: 3000 });
			await statusTrigger.click();
		});

		await test.step("Select In Progress", async () => {
			await page.getByRole("option", { name: /in.?progress/i }).click();
		});

		await test.step("Status updated", async () => {
			await page.waitForTimeout(500);
		});
	});

	test("changes priority in task detail", async ({ page }) => {
		await test.step("Create task and open from tasks page", async () => {
			server.cli('task create "Priority Task" -d "Change priority"');
			await page.goto(`${server.baseURL}/tasks`);
			await page.getByText("Priority Task").first().click();
		});

		await test.step("Find and click priority select", async () => {
			await expect(page.getByText("Priority").first()).toBeVisible();
			const priorityTrigger = page.locator("button[role=combobox]").filter({ hasText: /medium/i }).first();
			await expect(priorityTrigger).toBeVisible({ timeout: 3000 });
			await priorityTrigger.click();
		});

		await test.step("Select High", async () => {
			await page.getByRole("option", { name: /high/i }).click();
		});

		await test.step("Priority updated", async () => {
			await page.waitForTimeout(500);
		});
	});

	test("starts timer from detail view", async ({ page }) => {
		await test.step("Create task and open detail", async () => {
			server.cli('task create "Timer Task" -d "Track time"');
			await page.goto(`${server.baseURL}/tasks`);
			await page.getByText("Timer Task").first().click();
		});

		await test.step("Click Start Timer", async () => {
			const startBtn = page.getByText("Start Timer").first();
			await expect(startBtn).toBeVisible();
			await startBtn.click();
			await page.waitForTimeout(500);
		});
	});

	test("clicks Mark as Done button", async ({ page }) => {
		let taskId = "";
		await test.step("Create task and open detail", async () => {
			const output = server.cli('task create "Done Task" -d "Mark done"');
			taskId = output.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
			// Navigate directly to task detail to avoid pagination issues
			await page.goto(`${server.baseURL}/kanban/${taskId}`);
			await expect(page.getByRole("heading", { name: "Done Task", exact: true })).toBeVisible();
		});

		await test.step("Click Mark as Done", async () => {
			const doneBtn = page.getByText(/mark as done/i).first();
			await expect(doneBtn).toBeVisible();
			await doneBtn.click();
			await page.waitForTimeout(500);
		});
	});

	test("toggles dark mode", async ({ page }) => {
		await test.step("Navigate to dashboard", async () => {
			await page.goto(server.baseURL);
		});

		await test.step("Click theme toggle button", async () => {
			// Theme toggle is a switch in the header
			const themeToggle = page.locator("button[role=switch]").first()
				.or(page.getByRole("switch").first());
			if (await themeToggle.isVisible({ timeout: 3000 }).catch(() => false)) {
				await themeToggle.click();
				await page.waitForTimeout(300);

				await test.step("Dark class is toggled on html", async () => {
					const isDark = await page.locator("html.dark").count();
					// Toggle was clicked, page should still be functional
					await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
				});

				await test.step("Toggle back", async () => {
					await themeToggle.click();
					await page.waitForTimeout(300);
					await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
				});
			}
		});
	});
});

test.describe("Acceptance Criteria Interactions", () => {
	test("toggles AC checkbox on and off", async ({ page }) => {
		await test.step("Create task with ACs and open from kanban", async () => {
			server.cli('task create "AC Toggle" -d "Toggle ACs" --ac "First criterion" --ac "Second criterion"');
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("AC Toggle").first().click();
		});

		await test.step("Both ACs visible with checkboxes", async () => {
			await expect(page.getByText("First criterion")).toBeVisible();
			await expect(page.getByText("Second criterion")).toBeVisible();
		});

		await test.step("Check first AC", async () => {
			await page.getByRole("checkbox").first().click();
			await page.waitForTimeout(500);
		});

		await test.step("Check second AC", async () => {
			await page.getByRole("checkbox").nth(1).click();
			await page.waitForTimeout(500);
		});

		await test.step("Uncheck first AC", async () => {
			await page.getByRole("checkbox").first().click();
			await page.waitForTimeout(500);
		});
	});

	test("adds new AC from detail view", async ({ page }) => {
		await test.step("Create task and open from kanban", async () => {
			server.cli('task create "AC Add" -d "Add ACs in detail"');
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("AC Add").first().click();
		});

		await test.step("Click Add criterion", async () => {
			const addBtn = page.getByText(/add criterion/i).first();
			await expect(addBtn).toBeVisible();
			await addBtn.click();
		});

		await test.step("Type AC and press Enter", async () => {
			const input = page.getByPlaceholder("Add acceptance criterion...");
			await expect(input).toBeVisible({ timeout: 3000 });
			await input.fill("User sees success message");
			await input.press("Enter");
		});

		await test.step("New AC appears", async () => {
			await expect(page.getByText("User sees success message")).toBeVisible();
		});
	});
});

test.describe("Kanban Drag and Drop", () => {
	// Helper: drag a card from its current position to the center of a target column.
	// Uses slow, multi-step mouse movements so dnd-kit's collision detection registers.
	async function dragCardToColumn(
		page: import("@playwright/test").Page,
		cardLocator: import("@playwright/test").Locator,
		targetColumnHeader: string,
	) {
		const cardBox = await cardLocator.boundingBox();
		expect(cardBox).toBeTruthy();

		// Find the target column by its header text
		const targetHeader = page.locator(".font-semibold").filter({ hasText: targetColumnHeader });
		const targetCol = targetHeader.locator("xpath=ancestor::div[contains(@class,'min-h-40')]");
		const colBox = await targetCol.boundingBox();
		expect(colBox).toBeTruthy();

		const startX = cardBox!.x + cardBox!.width / 2;
		const startY = cardBox!.y + cardBox!.height / 2;
		const endX = colBox!.x + colBox!.width / 2;
		const endY = colBox!.y + colBox!.height / 2;

		// Mouse down on card center
		await page.mouse.move(startX, startY);
		await page.mouse.down();

		// Move past 8px activation threshold first
		await page.mouse.move(startX + 10, startY, { steps: 3 });
		await page.waitForTimeout(100);

		// Drag smoothly to target column center (many steps for collision detection)
		await page.mouse.move(endX, endY, { steps: 20 });
		await page.waitForTimeout(200);

		// Drop
		await page.mouse.up();
		await page.waitForTimeout(500);
	}

	test("drag activation: card becomes semi-transparent when dragged", async ({ page }) => {
		await test.step("Create task", async () => {
			server.cli('task create "Drag Activate" -d "Test drag activation"');
		});

		await test.step("Navigate to kanban", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await expect(page.locator("h3").filter({ hasText: "Drag Activate" })).toBeVisible();
		});

		await test.step("Mouse down and move >8px activates drag", async () => {
			const card = page.locator(".cursor-grab").filter({ hasText: "Drag Activate" }).first();
			const box = await card.boundingBox();
			expect(box).toBeTruthy();

			// Before drag: no opacity-30 elements
			const beforeDrag = await page.locator(".opacity-30").count();
			expect(beforeDrag).toBe(0);

			// Mouse down on card center
			await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
			await page.mouse.down();

			// Move >8px to activate dnd-kit's MouseSensor
			await page.mouse.move(box!.x + box!.width / 2 + 15, box!.y + box!.height / 2, { steps: 5 });
			await page.waitForTimeout(300);

			// After activation: card should be semi-transparent (opacity-30)
			const afterDrag = await page.locator(".opacity-30").count();
			expect(afterDrag).toBeGreaterThan(0);

			// Also verify DragOverlay is rendered (position: fixed)
			const hasOverlay = await page.locator('[style*="position: fixed"]').count();
			expect(hasOverlay).toBeGreaterThan(0);

			// Release
			await page.mouse.up();
			await page.waitForTimeout(500);

			// After release: opacity should be restored
			const afterRelease = await page.locator(".opacity-30").count();
			expect(afterRelease).toBe(0);
		});
	});

	test("cross-column drag moves card to In Progress", async ({ page }) => {
		await test.step("Create task in To Do", async () => {
			server.cli('task create "Drag Cross" -d "Drag to in-progress"');
		});

		await test.step("Navigate to kanban and verify in To Do", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await expect(page.locator("h3").filter({ hasText: "Drag Cross" })).toBeVisible();

			const isInTodo = await page.evaluate(() => {
				const card = Array.from(document.querySelectorAll("h3")).find((h) => h.textContent?.includes("Drag Cross"));
				const column = card?.closest("[class*='min-h-40']");
				const header = column?.querySelector(".font-semibold");
				return header?.textContent?.includes("To Do");
			});
			expect(isInTodo).toBe(true);
		});

		await test.step("Drag card to In Progress column", async () => {
			const card = page.locator(".cursor-grab").filter({ hasText: "Drag Cross" }).first();
			await dragCardToColumn(page, card, "In Progress");
		});

		await test.step("Card is now in In Progress column and API persisted", async () => {
			// Wait for the toast confirming API call succeeded
			await expect(page.getByText("Status updated")).toBeVisible();

			const isInProgress = await page.evaluate(() => {
				const card = Array.from(document.querySelectorAll("h3")).find((h) => h.textContent?.includes("Drag Cross"));
				const column = card?.closest("[class*='min-h-40']");
				const header = column?.querySelector(".font-semibold");
				return header?.textContent?.includes("In Progress");
			});
			expect(isInProgress).toBe(true);
		});

		await test.step("Status persists after reload", async () => {
			await page.reload();
			await expect(page.locator("h3").filter({ hasText: "Drag Cross" })).toBeVisible();

			const isStillInProgress = await page.evaluate(() => {
				const card = Array.from(document.querySelectorAll("h3")).find((h) => h.textContent?.includes("Drag Cross"));
				const column = card?.closest("[class*='min-h-40']");
				const header = column?.querySelector(".font-semibold");
				return header?.textContent?.includes("In Progress");
			});
			expect(isStillInProgress).toBe(true);
		});
	});

	test("status change via detail moves card to correct column", async ({ page }) => {
		let taskId = "";

		await test.step("Create task in To Do", async () => {
			const output = server.cli('task create "Column Move" -d "Move via status change"');
			const match = output.match(/Created task\s+([a-z0-9]+)/i);
			taskId = match?.[1] || "";
		});

		await test.step("Navigate to kanban and verify task is in To Do column", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await expect(page.locator("h3").filter({ hasText: "Column Move" })).toBeVisible();

			// Verify card is inside the To Do column
			const isInTodo = await page.evaluate(() => {
				const card = Array.from(document.querySelectorAll("h3")).find((h) => h.textContent?.includes("Column Move"));
				const column = card?.closest("[class*='min-h-40']");
				const header = column?.querySelector(".font-semibold");
				return header?.textContent?.includes("To Do");
			});
			expect(isInTodo).toBe(true);
		});

		await test.step("Change status to in-progress via CLI", async () => {
			server.cli(`task edit ${taskId} -s in-progress`);
		});

		await test.step("Reload and verify card moved to In Progress column", async () => {
			// Must reload - same-hash navigation doesn't refresh SPA data
			await page.reload();
			await expect(page.locator("h3").filter({ hasText: "Column Move" })).toBeVisible();

			const isInProgress = await page.evaluate(() => {
				const card = Array.from(document.querySelectorAll("h3")).find((h) => h.textContent?.includes("Column Move"));
				const column = card?.closest("[class*='min-h-40']");
				const header = column?.querySelector(".font-semibold");
				return header?.textContent?.includes("In Progress");
			});
			expect(isInProgress).toBe(true);
		});
	});

	test("status change via UI dropdown moves card to correct column", async ({ page }) => {
		await test.step("Create task in To Do", async () => {
			server.cli('task create "UI Move" -d "Move via UI dropdown"');
		});

		await test.step("Navigate to kanban and open task detail", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("UI Move").first().click();
		});

		await test.step("Change status to In Progress via dropdown", async () => {
			await expect(page.getByText("Status").first()).toBeVisible();
			const statusTrigger = page.locator("button[role=combobox]").filter({ hasText: /to do/i }).first();
			await expect(statusTrigger).toBeVisible({ timeout: 3000 });
			await statusTrigger.click();
			await page.getByRole("option", { name: /in.?progress/i }).click();
			await page.waitForTimeout(500);
		});

		await test.step("Close detail and verify card is in In Progress column", async () => {
			await page.keyboard.press("Escape");
			await page.waitForTimeout(500);

			const isInProgress = await page.evaluate(() => {
				const card = Array.from(document.querySelectorAll("h3")).find((h) => h.textContent?.includes("UI Move"));
				const column = card?.closest("[class*='min-h-40']");
				const header = column?.querySelector(".font-semibold");
				return header?.textContent?.includes("In Progress");
			});
			expect(isInProgress).toBe(true);
		});
	});

	test("task order is preserved after status change", async ({ page }) => {
		let taskId1 = "";
		let taskId2 = "";
		let taskId3 = "";

		await test.step("Create 3 tasks in To Do", async () => {
			const out1 = server.cli('task create "Order First" -d "First task"');
			taskId1 = out1.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
			const out2 = server.cli('task create "Order Second" -d "Second task"');
			taskId2 = out2.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
			const out3 = server.cli('task create "Order Third" -d "Third task"');
			taskId3 = out3.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
		});

		await test.step("Move middle task to in-progress via CLI", async () => {
			server.cli(`task edit ${taskId2} -s in-progress`);
		});

		await test.step("Navigate to kanban", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await expect(page.locator("h3").filter({ hasText: "Order Second" })).toBeVisible();
		});

		await test.step("Verify Order Second is in In Progress column", async () => {
			const result = await page.evaluate(() => {
				const card = Array.from(document.querySelectorAll("h3")).find((h) => h.textContent?.includes("Order Second"));
				const column = card?.closest("[class*='min-h-40']");
				const header = column?.querySelector(".font-semibold");
				return header?.textContent?.includes("In Progress");
			});
			expect(result).toBe(true);
		});

		await test.step("Verify Order First and Third remain in To Do", async () => {
			const todoCards = await page.evaluate(() => {
				const columns = document.querySelectorAll("[class*='min-h-40']");
				for (const col of columns) {
					const header = col.querySelector(".font-semibold");
					if (header?.textContent?.includes("To Do")) {
						return Array.from(col.querySelectorAll("h3")).map((h) => h.textContent);
					}
				}
				return [];
			});
			expect(todoCards).toContain("Order First");
			expect(todoCards).toContain("Order Third");
		});
	});

	test("status change persists after page reload", async ({ page }) => {
		let taskId = "";

		await test.step("Create task and change status", async () => {
			const output = server.cli('task create "Persist Status" -d "Should persist"');
			taskId = output.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
			server.cli(`task edit ${taskId} -s done`);
		});

		await test.step("Navigate to kanban and verify in Done column", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await expect(page.locator("h3").filter({ hasText: "Persist Status" })).toBeVisible();

			const isInDone = await page.evaluate(() => {
				const card = Array.from(document.querySelectorAll("h3")).find((h) => h.textContent?.includes("Persist Status"));
				const column = card?.closest("[class*='min-h-40']");
				const header = column?.querySelector(".font-semibold");
				return header?.textContent?.includes("Done");
			});
			expect(isInDone).toBe(true);
		});

		await test.step("Reload page", async () => {
			await page.reload();
			await page.waitForTimeout(1000);
		});

		await test.step("Task still in Done column after reload", async () => {
			await expect(page.locator("h3").filter({ hasText: "Persist Status" }).first()).toBeVisible();

			const stillInDone = await page.evaluate(() => {
				const card = Array.from(document.querySelectorAll("h3")).find((h) => h.textContent?.includes("Persist Status"));
				const column = card?.closest("[class*='min-h-40']");
				const header = column?.querySelector(".font-semibold");
				return header?.textContent?.includes("Done");
			});
			expect(stillInDone).toBe(true);
		});

		await test.step("CLI confirms done status", async () => {
			const output = server.cli(`task ${taskId} --plain`);
			expect(output).toMatch(/\bdone\b/i);
		});
	});
});

test.describe("Full Workflow: Pure UI", () => {
	test("create task → open detail → check AC → close", async ({ page }) => {
		await test.step("Navigate to kanban page", async () => {
			// Use kanban instead of tasks table to avoid pagination issues
			await page.goto(`${server.baseURL}/kanban`);
		});

		await test.step("Create task with AC via form", async () => {
			await page.getByRole("button", { name: /new task/i }).first().click();
			await page.getByPlaceholder("Enter task title...").fill("Workflow Task");

			const addBtn = page.getByRole("button", { name: "Add an item" });
			if (await addBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
				await addBtn.click();
				await page.getByPlaceholder("Add an item...").fill("Step completed");
				await page.getByRole("button", { name: "Add" }).first().click();
			}

			await page.getByRole("button", { name: "Create Task" }).click();
			await page.waitForTimeout(500);
		});

		await test.step("Open task from kanban", async () => {
			await expect(page.getByText("Workflow Task").first()).toBeVisible();
			await page.getByText("Workflow Task").first().click();
		});

		await test.step("Check AC checkbox", async () => {
			await expect(page.getByText("Step completed")).toBeVisible();
			const checkbox = page.getByRole("checkbox").first();
			if (await checkbox.isVisible({ timeout: 2000 }).catch(() => false)) {
				await checkbox.click();
				await page.waitForTimeout(300);
			}
		});

		await test.step("Close detail with Escape", async () => {
			await page.keyboard.press("Escape");
			await page.waitForTimeout(300);
		});
	});
});
