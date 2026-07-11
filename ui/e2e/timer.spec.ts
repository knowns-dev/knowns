import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	stopAllTimers();
	server?.cleanup();
});

/** Stop up to 5 leftover timers to ensure clean state */
function stopAllTimers() {
	for (let i = 0; i < 5; i++) {
		try { server.cli("time stop"); } catch { break; }
	}
}

test.describe("Timer Start & Stop", () => {
	test.beforeEach(() => stopAllTimers());

	test("starts timer from task detail and shows in header", async ({ page }) => {
		let taskId = "";

		await test.step("Create task", async () => {
			const output = server.cli('task create "Build Feature" -d "Verify timer activation"');
			taskId = output.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
		});

		await test.step("Open task detail from kanban", async () => {
			await page.goto(`${server.baseURL}/kanban/${taskId}`);
			await expect(page.getByRole("heading", { name: "Build Feature", exact: true })).toBeVisible();
		});

		await test.step("Click Start Timer and wait for API response", async () => {
			const dialog = page.locator('[role="dialog"]');
			const startBtn = dialog.locator("button").filter({ hasText: "Start Timer" }).first();
			await expect(startBtn).toBeVisible();

			// Click and wait for the time API response
			await Promise.all([
				page.waitForResponse(
					(resp) => resp.url().includes("/time/") && resp.ok(),
					{ timeout: 10000 }
				),
				startBtn.click(),
			]);
			// Give UI time to re-render after state update
			await page.waitForTimeout(500);
		});

		await test.step("Pause and Stop buttons replace Start Timer", async () => {
			// Target buttons INSIDE the dialog only (sidebar buttons have text, header buttons don't)
			const dialog = page.locator('[role="dialog"]');
			await expect(dialog.locator("button").filter({ hasText: "Pause" })).toBeVisible();
			await expect(dialog.locator("button").filter({ hasText: "Stop" })).toBeVisible();
		});

		await test.step("Header shows running timer with animated indicator", async () => {
			await page.keyboard.press("Escape");
			await page.waitForTimeout(300);
			await expect(page.locator(".animate-ping").first()).toBeVisible();
			await expect(page.getByText(`#${taskId}`).first()).toBeVisible();
		});

		await test.step("Header shows elapsed time in HH:MM:SS", async () => {
			await page.waitForTimeout(1500);
			const timeText = await page.locator(".font-mono.tabular-nums").first().textContent();
			expect(timeText).toMatch(/\d{2}:\d{2}:\d{2}/);
		});

		await test.step("Cleanup", async () => {
			server.cli("time stop");
		});
	});

	test("stops timer from task detail", async ({ page }) => {
		let taskId = "";

		await test.step("Create task and start timer via CLI", async () => {
			const output = server.cli('task create "Write Tests" -d "Verify shutdown flow"');
			taskId = output.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
			server.cli(`time start ${taskId}`);
		});

		await test.step("Open task detail", async () => {
			await page.goto(`${server.baseURL}/kanban/${taskId}`);
			await expect(page.getByRole("heading", { name: "Write Tests", exact: true })).toBeVisible();
		});

		await test.step("Timer buttons visible in dialog", async () => {
			const dialog = page.locator('[role="dialog"]');
			await expect(dialog.locator("button").filter({ hasText: "Pause" })).toBeVisible();
		});

		await test.step("Click Stop button inside dialog and wait for API", async () => {
			const dialog = page.locator('[role="dialog"]');
			const stopBtn = dialog.locator("button").filter({ hasText: "Stop" });
			await Promise.all([
				page.waitForResponse(
					(resp) => resp.url().includes("/time/") && resp.ok(),
					{ timeout: 10000 },
				),
				stopBtn.click(),
			]);
			await page.waitForTimeout(500);
		});

		await test.step("Start Timer reappears", async () => {
			const dialog = page.locator('[role="dialog"]');
			await expect(dialog.locator("button").filter({ hasText: "Start Timer" }).first()).toBeVisible();
		});

		await test.step("Header no longer shows timer indicator", async () => {
			await page.keyboard.press("Escape");
			await page.waitForTimeout(500);
			const pingCount = await page.locator(".animate-ping").count();
			expect(pingCount).toBe(0);
		});
	});

	test("stops timer from header", async ({ page }) => {
		let taskId = "";

		await test.step("Create task and start timer", async () => {
			const output = server.cli('task create "Deploy App" -d "Verify header controls"');
			taskId = output.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
			server.cli(`time start ${taskId}`);
		});

		await test.step("Navigate to kanban and verify timer", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await expect(page.locator(".animate-ping").first()).toBeVisible();
		});

		await test.step("Click stop button in header (title=Stop)", async () => {
			const stopBtn = page.locator("button[title='Stop']").first();
			await expect(stopBtn).toBeVisible();
			await stopBtn.click();
			await page.waitForTimeout(500);
		});

		await test.step("Timer indicator gone", async () => {
			const pingCount = await page.locator(".animate-ping").count();
			expect(pingCount).toBe(0);
		});
	});
});

test.describe("Timer Pause & Resume", () => {
	test.beforeEach(() => stopAllTimers());

	test("pauses and resumes from task detail", async ({ page }) => {
		let taskId = "";

		await test.step("Create task and start timer", async () => {
			const output = server.cli('task create "Code Review" -d "Verify workflow"');
			taskId = output.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
			server.cli(`time start ${taskId}`);
		});

		await test.step("Open task detail", async () => {
			await page.goto(`${server.baseURL}/kanban/${taskId}`);
			await expect(page.getByRole("heading", { name: "Code Review", exact: true })).toBeVisible();
		});

		await test.step("Click Pause button in dialog", async () => {
			const dialog = page.locator('[role="dialog"]');
			const pauseBtn = dialog.locator("button").filter({ hasText: "Pause" });
			await expect(pauseBtn).toBeVisible();
			await pauseBtn.click();
			await page.waitForTimeout(500);
		});

		await test.step("Resume button appears in dialog", async () => {
			const dialog = page.locator('[role="dialog"]');
			await expect(dialog.locator("button").filter({ hasText: "Resume" })).toBeVisible();
		});

		await test.step("Click Resume button in dialog", async () => {
			const dialog = page.locator('[role="dialog"]');
			await dialog.locator("button").filter({ hasText: "Resume" }).click();
			await page.waitForTimeout(500);
		});

		await test.step("Pause button reappears (resumed)", async () => {
			const dialog = page.locator('[role="dialog"]');
			await expect(dialog.locator("button").filter({ hasText: "Pause" })).toBeVisible();
		});

		await test.step("Cleanup", async () => {
			server.cli("time stop");
		});
	});

	test("pauses and resumes from header buttons", async ({ page }) => {
		let taskId = "";

		await test.step("Create task and start timer", async () => {
			const output = server.cli('task create "Fix Linting" -d "Verify header controls"');
			taskId = output.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
			server.cli(`time start ${taskId}`);
		});

		await test.step("Navigate and verify running indicator", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await expect(page.locator(".animate-ping").first()).toBeVisible();
		});

		await test.step("Click Pause in header", async () => {
			const pauseBtn = page.locator("button[title='Pause']").first();
			await expect(pauseBtn).toBeVisible();
			await pauseBtn.click();
			await page.waitForTimeout(500);
		});

		await test.step("Paused indicator shown (no more red ping)", async () => {
			const pingCount = await page.locator(".animate-ping").count();
			expect(pingCount).toBe(0);
			// Resume button appears in header (title changes from Pause to Resume)
			await expect(page.locator("button[title='Resume']").first()).toBeVisible();
		});

		await test.step("Click Resume in header", async () => {
			const resumeBtn = page.locator("button[title='Resume']").first();
			await resumeBtn.click();
			await page.waitForTimeout(500);
		});

		await test.step("Red running indicator returns", async () => {
			await expect(page.locator(".animate-ping").first()).toBeVisible();
		});

		await test.step("Cleanup", async () => {
			server.cli("time stop");
		});
	});
});

test.describe("Timer Persistence", () => {
	test.beforeEach(() => stopAllTimers());

	test("timer persists across page navigation", async ({ page }) => {
		let taskId = "";

		await test.step("Create task and start timer", async () => {
			const output = server.cli('task create "Nav Task" -d "Persists across pages"');
			taskId = output.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
			server.cli(`time start ${taskId}`);
		});

		await test.step("Kanban page - timer visible", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await expect(page.locator(".animate-ping").first()).toBeVisible();
		});

		await test.step("Tasks page - timer still visible", async () => {
			await page.getByText("Tasks", { exact: true }).first().click();
			await expect(page).toHaveURL(/\/tasks/);
			await expect(page.locator(".animate-ping").first()).toBeVisible();
		});

		await test.step("Docs page - timer still visible", async () => {
			await page.getByText("Docs", { exact: true }).first().click();
			await expect(page).toHaveURL(/\/docs/);
			await expect(page.locator(".animate-ping").first()).toBeVisible();
		});

		await test.step("Dashboard - timer still visible", async () => {
			await page.getByText("Dashboard", { exact: true }).first().click();
			await expect(page.locator(".animate-ping").first()).toBeVisible();
		});

		await test.step("Cleanup", async () => {
			server.cli("time stop");
		});
	});

	test("timer persists after page reload", async ({ page }) => {
		let taskId = "";

		await test.step("Create task and start timer", async () => {
			const output = server.cli('task create "Reload Task" -d "Survives reload"');
			taskId = output.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
			server.cli(`time start ${taskId}`);
		});

		await test.step("Navigate and verify", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await expect(page.locator(".animate-ping").first()).toBeVisible();
		});

		await test.step("Reload page", async () => {
			await page.reload();
			await page.waitForTimeout(1000);
		});

		await test.step("Timer still visible after reload", async () => {
			await expect(page.locator(".animate-ping").first()).toBeVisible();
			await expect(page.getByText(`#${taskId}`).first()).toBeVisible();
		});

		await test.step("Cleanup", async () => {
			server.cli("time stop");
		});
	});

	test("timer started via CLI appears in UI", async ({ page }) => {
		let taskId = "";

		await test.step("Create task and start timer via CLI", async () => {
			const output = server.cli('task create "CLI Task" -d "Started via CLI"');
			taskId = output.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
			server.cli(`time start ${taskId}`);
		});

		await test.step("Navigate - timer visible in header", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await expect(page.locator(".animate-ping").first()).toBeVisible();
			await expect(page.getByText(`#${taskId}`).first()).toBeVisible();
		});

		await test.step("Open task detail - shows Pause/Stop (not Start Timer)", async () => {
			await page.getByText("CLI Task").first().click();
			const dialog = page.locator('[role="dialog"]');
			await expect(dialog.getByRole("heading", { name: "CLI Task", exact: true })).toBeVisible();
			await expect(dialog.locator("button").filter({ hasText: "Pause" })).toBeVisible();
			await expect(dialog.locator("button").filter({ hasText: "Stop" })).toBeVisible();
		});

		await test.step("Cleanup", async () => {
			server.cli("time stop");
		});
	});
});

test.describe("Time Tracking Logs", () => {
	test.beforeEach(() => stopAllTimers());

	test("completed timer shows in time tracking logs", async ({ page }) => {
		let taskId = "";

		await test.step("Create task and add time via CLI", async () => {
			const output = server.cli('task create "Log Task" -d "Check time logs"');
			taskId = output.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
			server.cli(`time add ${taskId} 30m`);
		});

		await test.step("Open task detail", async () => {
			await page.goto(`${server.baseURL}/kanban/${taskId}`);
			await expect(page.getByRole("heading", { name: "Log Task", exact: true })).toBeVisible();
		});

		await test.step("Scroll to Time Tracking section", async () => {
			const timeSection = page.getByText("Time Tracking").first();
			await timeSection.scrollIntoViewIfNeeded();
			await expect(timeSection).toBeVisible();
		});

		await test.step("Total time shown", async () => {
			await expect(page.getByText("30m").first()).toBeVisible();
		});
	});

	test("multiple time entries show total", async ({ page }) => {
		let taskId = "";

		await test.step("Create task with multiple manual entries", async () => {
			const output = server.cli('task create "Multi Log" -d "Multiple entries"');
			taskId = output.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
			server.cli(`time add ${taskId} 1h`);
			server.cli(`time add ${taskId} 45m`);
		});

		await test.step("Open task detail", async () => {
			await page.goto(`${server.baseURL}/kanban/${taskId}`);
			await expect(page.getByRole("heading", { name: "Multi Log", exact: true })).toBeVisible();
		});

		await test.step("Scroll to Time Tracking section", async () => {
			const timeSection = page.getByText("Time Tracking").first();
			await timeSection.scrollIntoViewIfNeeded();
			await expect(timeSection).toBeVisible();
		});

		await test.step("Total time shown (1h 45m)", async () => {
			await expect(page.getByText(/1h\s*45m/).first()).toBeVisible();
		});
	});

	test("recording badge shows when timer is active", async ({ page }) => {
		let taskId = "";

		await test.step("Create task and start timer", async () => {
			const output = server.cli('task create "Active Task" -d "Shows recording badge"');
			taskId = output.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
			server.cli(`time start ${taskId}`);
		});

		await test.step("Open task detail", async () => {
			await page.goto(`${server.baseURL}/kanban/${taskId}`);
			await expect(page.getByRole("heading", { name: "Active Task", exact: true })).toBeVisible();
		});

		await test.step("Scroll to Time Tracking and check Recording badge", async () => {
			const timeSection = page.getByText("Time Tracking").first();
			await timeSection.scrollIntoViewIfNeeded();
			await expect(page.getByText("Recording...").first()).toBeVisible();
		});

		await test.step("Cleanup", async () => {
			server.cli("time stop");
		});
	});
});

test.describe("Timer Elapsed Time", () => {
	test.beforeEach(() => stopAllTimers());

	test("elapsed time increments while running", async ({ page }) => {
		let taskId = "";

		await test.step("Create task and start timer", async () => {
			const output = server.cli('task create "Counting" -d "Watch time tick"');
			taskId = output.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
			server.cli(`time start ${taskId}`);
		});

		await test.step("Navigate and wait for timer display", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await expect(page.locator(".font-mono.tabular-nums").first()).toBeVisible();
		});

		await test.step("Time increments over 2 seconds", async () => {
			const timeDisplay = page.locator(".font-mono.tabular-nums").first();
			const time1 = await timeDisplay.textContent();

			await page.waitForTimeout(2000);

			const time2 = await timeDisplay.textContent();

			expect(time1).toMatch(/\d{2}:\d{2}:\d{2}/);
			expect(time2).toMatch(/\d{2}:\d{2}:\d{2}/);
			expect(time1).not.toBe(time2);
		});

		await test.step("Cleanup", async () => {
			server.cli("time stop");
		});
	});

	test("elapsed time freezes when paused", async ({ page }) => {
		let taskId = "";

		await test.step("Create task, start then pause timer", async () => {
			const output = server.cli('task create "Frozen" -d "Time freezes when paused"');
			taskId = output.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
			server.cli(`time start ${taskId}`);
			await page.waitForTimeout(500);
			server.cli(`time pause ${taskId}`);
		});

		await test.step("Navigate to kanban", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await expect(page.locator(".font-mono.tabular-nums").first()).toBeVisible();
		});

		await test.step("Time does not increment when paused", async () => {
			const timeDisplay = page.locator(".font-mono.tabular-nums").first();
			const time1 = await timeDisplay.textContent();

			await page.waitForTimeout(2000);

			const time2 = await timeDisplay.textContent();
			expect(time1).toBe(time2);
		});

		await test.step("Cleanup", async () => {
			server.cli("time stop");
		});
	});
});

test.describe("Multiple Timers", () => {
	test.beforeEach(() => stopAllTimers());

	test("two timers show dropdown with count", async ({ page }) => {
		let taskId1 = "";
		let taskId2 = "";

		await test.step("Create two tasks and start both timers", async () => {
			const out1 = server.cli('task create "Task Alpha" -d "First timer"');
			taskId1 = out1.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
			const out2 = server.cli('task create "Task Beta" -d "Second timer"');
			taskId2 = out2.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
			server.cli(`time start ${taskId1}`);
			server.cli(`time start ${taskId2}`);
		});

		await test.step("Navigate to kanban", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.waitForTimeout(1000);
		});

		await test.step("Header shows timer count and running info", async () => {
			await expect(page.getByText("2 running").first()).toBeVisible();
		});

		await test.step("Cleanup", async () => {
			server.cli(`time stop ${taskId1}`);
			server.cli(`time stop ${taskId2}`);
		});
	});

	test("stop all timers via dropdown", async ({ page }) => {
		let taskId1 = "";
		let taskId2 = "";

		await test.step("Create tasks and start timers", async () => {
			const out1 = server.cli('task create "Batch One" -d "First"');
			taskId1 = out1.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
			const out2 = server.cli('task create "Batch Two" -d "Second"');
			taskId2 = out2.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
			server.cli(`time start ${taskId1}`);
			server.cli(`time start ${taskId2}`);
		});

		await test.step("Navigate and verify timers running", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await expect(page.getByText("2 running").first()).toBeVisible();
		});

		await test.step("Open dropdown and click Stop all timers", async () => {
			await page.getByText("2 running").first().click();
			await page.waitForTimeout(300);
			await page.getByText("Stop all timers").click();
			await page.waitForTimeout(500);
		});

		await test.step("No timer indicators remain", async () => {
			const pingCount = await page.locator(".animate-ping").count();
			expect(pingCount).toBe(0);
		});
	});
});
