import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
	// Seed some data for visual tests
	server.cli('task create "Dark Mode Task" -d "Test in dark mode" --priority high');
	server.cli('task create "Light Mode Task" -d "Test in light mode" --priority low');
	server.cli('doc create "Theme Test Doc" -d "Document for theme testing" -t "test"');
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Dark Mode Toggle", () => {
	test("toggles dark mode via switch button", async ({ page }) => {
		await test.step("Navigate to dashboard", async () => {
			await page.goto(server.baseURL);
			await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
		});

		await test.step("Find theme toggle switch", async () => {
			const toggle = page.getByRole("switch");
			await expect(toggle).toBeVisible({ timeout: 3000 });
		});

		await test.step("Click toggle to enable dark mode", async () => {
			const toggle = page.getByRole("switch");
			await toggle.click();
			await page.waitForTimeout(400);
		});

		await test.step("HTML element has dark class", async () => {
			const htmlClass = await page.locator("html").getAttribute("class");
			expect(htmlClass).toContain("dark");
		});

		await test.step("Toggle aria-checked is true", async () => {
			const toggle = page.getByRole("switch");
			await expect(toggle).toHaveAttribute("aria-checked", "true");
		});

		await test.step("Toggle label says 'Switch to light mode'", async () => {
			const toggle = page.getByRole("switch");
			await expect(toggle).toHaveAttribute("aria-label", "Switch to light mode");
		});
	});

	test("toggles back to light mode", async ({ page }) => {
		await test.step("Navigate and enable dark mode", async () => {
			await page.goto(server.baseURL);
			const toggle = page.getByRole("switch");
			await toggle.click();
			await page.waitForTimeout(400);
			const htmlClass = await page.locator("html").getAttribute("class");
			expect(htmlClass).toContain("dark");
		});

		await test.step("Click toggle again to disable dark mode", async () => {
			const toggle = page.getByRole("switch");
			await toggle.click();
			await page.waitForTimeout(400);
		});

		await test.step("HTML element no longer has dark class", async () => {
			const htmlClass = await page.locator("html").getAttribute("class");
			expect(htmlClass).not.toContain("dark");
		});

		await test.step("Toggle aria-checked is false", async () => {
			const toggle = page.getByRole("switch");
			await expect(toggle).toHaveAttribute("aria-checked", "false");
		});

		await test.step("Toggle label says 'Switch to dark mode'", async () => {
			const toggle = page.getByRole("switch");
			await expect(toggle).toHaveAttribute("aria-label", "Switch to dark mode");
		});
	});
});

test.describe("Dark Mode Persistence", () => {
	test("dark mode persists in localStorage", async ({ page }) => {
		await test.step("Navigate and enable dark mode", async () => {
			await page.goto(server.baseURL);
			const toggle = page.getByRole("switch");
			await toggle.click();
			await page.waitForTimeout(400);
		});

		await test.step("localStorage has theme=dark", async () => {
			const theme = await page.evaluate(() => localStorage.getItem("theme"));
			expect(theme).toBe("dark");
		});

		await test.step("Disable dark mode", async () => {
			const toggle = page.getByRole("switch");
			await toggle.click();
			await page.waitForTimeout(400);
		});

		await test.step("localStorage has theme=light", async () => {
			const theme = await page.evaluate(() => localStorage.getItem("theme"));
			expect(theme).toBe("light");
		});
	});

	test("dark mode persists across page navigation", async ({ page }) => {
		await test.step("Enable dark mode on dashboard", async () => {
			await page.goto(server.baseURL);
			const toggle = page.getByRole("switch");
			await toggle.click();
			await page.waitForTimeout(400);
			const htmlClass = await page.locator("html").getAttribute("class");
			expect(htmlClass).toContain("dark");
		});

		await test.step("Navigate to tasks page - still dark", async () => {
			await page.getByText("Tasks", { exact: true }).first().click();
			await expect(page).toHaveURL(/\/tasks/);
			const htmlClass = await page.locator("html").getAttribute("class");
			expect(htmlClass).toContain("dark");
		});

		await test.step("Navigate to kanban - still dark", async () => {
			await page.getByText("Kanban", { exact: true }).first().click();
			await expect(page).toHaveURL(/\/kanban/);
			const htmlClass = await page.locator("html").getAttribute("class");
			expect(htmlClass).toContain("dark");
		});

		await test.step("Navigate to docs - still dark", async () => {
			await page.getByText("Docs", { exact: true }).first().click();
			await expect(page).toHaveURL(/\/docs/);
			const htmlClass = await page.locator("html").getAttribute("class");
			expect(htmlClass).toContain("dark");
		});

		await test.step("Navigate to settings - still dark", async () => {
			await page.getByText("Settings", { exact: true }).first().click();
			await expect(page).toHaveURL(/\/config/);
			const htmlClass = await page.locator("html").getAttribute("class");
			expect(htmlClass).toContain("dark");
		});
	});

	test("dark mode restored on page reload", async ({ page }) => {
		await test.step("Enable dark mode", async () => {
			await page.goto(server.baseURL);
			const toggle = page.getByRole("switch");
			await toggle.click();
			await page.waitForTimeout(400);
		});

		await test.step("Reload page", async () => {
			await page.reload();
			await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
		});

		await test.step("Dark mode is still active after reload", async () => {
			const htmlClass = await page.locator("html").getAttribute("class");
			expect(htmlClass).toContain("dark");
			const toggle = page.getByRole("switch");
			await expect(toggle).toHaveAttribute("aria-checked", "true");
		});
	});
});

test.describe("Dark Mode on All Pages", () => {
	test("dashboard renders in dark mode", async ({ page }) => {
		await test.step("Enable dark mode and go to dashboard", async () => {
			await page.goto(server.baseURL);
			const toggle = page.getByRole("switch");
			await toggle.click();
			await page.waitForTimeout(400);
		});

		await test.step("Dashboard heading visible in dark mode", async () => {
			await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
		});

		await test.step("Task data visible in dark mode", async () => {
			await expect(page.getByText("Dark Mode Task").first()).toBeVisible();
		});
	});

	test("kanban board renders in dark mode", async ({ page }) => {
		await test.step("Enable dark mode", async () => {
			await page.goto(server.baseURL);
			const toggle = page.getByRole("switch");
			await toggle.click();
			await page.waitForTimeout(400);
		});

		await test.step("Navigate to kanban", async () => {
			await page.goto(`${server.baseURL}/kanban`);
		});

		await test.step("Kanban columns visible in dark mode", async () => {
			await expect(page.getByText("To Do").first()).toBeVisible();
			await expect(page.getByText("In Progress").first()).toBeVisible();
			await expect(page.getByText("Done", { exact: true }).first()).toBeVisible();
		});

		await test.step("Task cards visible in dark mode", async () => {
			await expect(page.getByText("Dark Mode Task").first()).toBeVisible();
		});
	});

	test("docs page renders in dark mode", async ({ page }) => {
		await test.step("Enable dark mode", async () => {
			await page.goto(server.baseURL);
			const toggle = page.getByRole("switch");
			await toggle.click();
			await page.waitForTimeout(400);
		});

		await test.step("Navigate to docs", async () => {
			await page.goto(`${server.baseURL}/docs`);
		});

		await test.step("Docs visible in dark mode", async () => {
			await expect(page.getByText("Theme Test Doc").first()).toBeVisible();
		});
	});

	test("task detail sheet renders in dark mode", async ({ page }) => {
		await test.step("Enable dark mode and open kanban", async () => {
			await page.goto(server.baseURL);
			const toggle = page.getByRole("switch");
			await toggle.click();
			await page.waitForTimeout(400);
			await page.goto(`${server.baseURL}/kanban`);
		});

		await test.step("Open task detail", async () => {
			await page.getByText("Dark Mode Task").first().click();
		});

		await test.step("Task detail visible in dark mode", async () => {
			await expect(page.getByRole("heading", { name: "Dark Mode Task", exact: true })).toBeVisible();
			await expect(page.getByText("Test in dark mode")).toBeVisible();
		});

		await test.step("Dark mode still active in detail sheet", async () => {
			const htmlClass = await page.locator("html").getAttribute("class");
			expect(htmlClass).toContain("dark");
		});
	});

	test("settings page renders in dark mode", async ({ page }) => {
		await test.step("Enable dark mode", async () => {
			await page.goto(server.baseURL);
			const toggle = page.getByRole("switch");
			await toggle.click();
			await page.waitForTimeout(400);
		});

		await test.step("Navigate to settings", async () => {
			await page.goto(`${server.baseURL}/config`);
		});

		await test.step("Settings content visible in dark mode", async () => {
			await expect(page.locator("body")).toBeVisible();
			const htmlClass = await page.locator("html").getAttribute("class");
			expect(htmlClass).toContain("dark");
		});
	});
});

test.describe("Dark Mode with Mentions", () => {
	test("mention badges visible in dark mode", async ({ page }) => {
		let taskId = "";

		await test.step("Create task with mentions", async () => {
			const output = server.cli('task create "Mentioned Task" -d "Referenced by another"');
			const match = output.match(/Created task\s+([a-z0-9]+)/i);
			taskId = match?.[1] || "";
			server.cli(`task create "Mentioner" -d "See @task-${taskId} for details"`);
		});

		await test.step("Enable dark mode and open kanban", async () => {
			await page.goto(server.baseURL);
			const toggle = page.getByRole("switch");
			await toggle.click();
			await page.waitForTimeout(400);
			await page.goto(`${server.baseURL}/kanban`);
		});

		await test.step("Open mentioning task", async () => {
			await page.getByText("Mentioner").first().click();
		});

		await test.step("Mention badge visible in dark mode", async () => {
			const badge = page.locator(`[data-task-id="${taskId}"]`);
			await expect(badge).toBeVisible();
			await expect(badge).toContainText("Mentioned Task");
		});

		await test.step("Dark mode still active", async () => {
			const htmlClass = await page.locator("html").getAttribute("class");
			expect(htmlClass).toContain("dark");
		});
	});
});
