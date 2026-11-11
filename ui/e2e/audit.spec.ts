import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Audit Trail", () => {
	test("audit page loads with header and tabs", async ({ page }) => {
		await test.step("Navigate to audit page", async () => {
			await page.goto(`${server.baseURL}/audit`);
		});

		await test.step("Audit page header is visible", async () => {
			await expect(page.getByRole("heading", { name: "MCP Audit Trail" })).toBeVisible();
			// The rework replaced the prose subtitle with a live count in the header.
			await expect(page.getByText(/^\d+ events$/)).toBeVisible();
			await expect(
				page.getByRole("navigation", { name: "Breadcrumb" }).getByText("Audit", {
					exact: true,
				}),
			).toBeVisible();
			await expect(
				page.getByRole("region", { name: "Audit status summary" }),
			).toBeVisible();
		});

		await test.step("Tabs are present", async () => {
			const recentTab = page.getByRole("tab", { name: "Recent Activity" });
			const statisticsTab = page.getByRole("tab", { name: "Statistics" });
			await expect(recentTab).toHaveAttribute(
				"aria-selected",
				"true",
			);
			await expect(statisticsTab).toBeVisible();
			await expect(page.getByRole("button", { name: /Refresh audit data/ })).toBeVisible();

			await recentTab.focus();
			await recentTab.press("ArrowRight");
			await expect(statisticsTab).toHaveAttribute("aria-selected", "true");
			await statisticsTab.press("Home");
			await expect(recentTab).toHaveAttribute("aria-selected", "true");
		});
	});

	test("recent tab shows empty state or events", async ({ page }) => {
		await test.step("Navigate to audit page", async () => {
			await page.goto(`${server.baseURL}/audit`);
		});

		await test.step("Recent Activity tab is selected by default", async () => {
			await expect(page.getByRole("tab", { name: "Recent Activity" })).toHaveAttribute(
				"aria-selected",
				"true",
			);
		});

		await test.step("Either shows events or empty state", async () => {
			const emptyState = page.getByText("No audit events found.");
			const eventRows = page.locator("[data-audit-event]").first();
			// Wait for loading to finish
			await page.waitForTimeout(2000);
			const isEmptyVisible = await emptyState.waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false);
			const hasEvents = await eventRows.waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false);
			expect(isEmptyVisible || hasEvents).toBeTruthy();
		});
	});

	test("performing MCP actions creates audit events", async ({ page }) => {
		await test.step("Perform an MCP action", async () => {
			const output = server.mcp("tasks", {
				action: "create",
				title: "Audit Trail Test",
				description: "Should appear in audit",
			});
			expect(output).toContain('"id":2');
		});

		await test.step("Navigate to audit page", async () => {
			await page.goto(`${server.baseURL}/audit`);
		});

		await test.step("Audit events are visible after action", async () => {
			// Wait for loading to complete
			await page.waitForTimeout(2000);
			const emptyState = page.getByText("No audit events found.");
			const isEmpty = await emptyState.waitFor({ state: "visible", timeout: 2000 }).then(() => true).catch(() => false);
			if (isEmpty) {
				// Refresh button is available
				const refreshBtn = page.getByRole("button", { name: /Refresh audit data/ });
				if (await refreshBtn.waitFor({ state: "visible", timeout: 2000 }).then(() => true).catch(() => false)) {
					await expect(refreshBtn).toBeEnabled();
					await refreshBtn.click();
					await page.waitForTimeout(2000);
				}
			}
			// Check for event text - should eventually show events
			await expect(emptyState).not.toBeVisible({ timeout: 10000 });
		});
	});

	test("filter controls are present in recent tab", async ({ page }) => {
		await test.step("Navigate to audit page", async () => {
			await page.goto(`${server.baseURL}/audit`);
		});

		await test.step("Wait for page to load", async () => {
			await expect(page.getByRole("heading", { name: "MCP Audit Trail" })).toBeVisible();
		});

		await test.step("Filter dropdowns are visible", async () => {
			await expect(page.getByLabel("Filter by tool")).toBeVisible();
			await expect(page.getByLabel("Filter by result")).toBeVisible();
		});

		await test.step("Event count text is shown", async () => {
			await expect(page.getByText(/events loaded$/)).toBeVisible();
			await expect(
				page
					.getByRole("region", { name: "Audit status summary" })
					.getByText("Events loaded"),
			).toBeVisible();
		});
	});

	test("statistics tab renders correctly", async ({ page }) => {
		await test.step("Navigate to audit page", async () => {
			await page.goto(`${server.baseURL}/audit`);
		});

		await test.step("Click Statistics tab", async () => {
			await page.getByRole("tab", { name: "Statistics" }).click();
			await page.waitForTimeout(1000);
		});

		await test.step("Statistics cards or empty state is visible", async () => {
			const emptyState = page.getByText("No audit data available.");
			// The rework renamed the headline metric to "Calls in range".
			const rangeSummary = page.getByRole("region", { name: "Range summary" });
			const isEmpty = await emptyState.waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false);
			const hasStats = await rangeSummary.waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false);
			expect(isEmpty || hasStats).toBeTruthy();
		});
	});

	test("statistics shows the trend, what needs attention and opens Recent Activity from them", async ({ page }) => {
		// One real call so the all-time totals are not empty; the range analytics and the failing calls are fixed below.
		server.mcp("tasks", { action: "list" });

		const bucket = (date: string, covered: boolean, success: number, errors: number, denied: number) => ({
			date,
			covered,
			totalCalls: covered ? success + errors + denied : 0,
			successCount: covered ? success : 0,
			errorCount: covered ? errors : 0,
			deniedCount: covered ? denied : 0,
			needsAttention: covered ? errors + denied : 0,
			averageDurationMs: covered ? 12 : 0,
			topToolCalls: 0,
		});
		const buckets = [
			bucket("2026-11-03", false, 0, 0, 0),
			bucket("2026-11-04", false, 0, 0, 0),
			bucket("2026-11-05", true, 4, 0, 0),
			bucket("2026-11-06", true, 9, 2, 1),
			bucket("2026-11-07", true, 0, 0, 0),
			bucket("2026-11-08", true, 3, 0, 0),
		];
		const failing = [
			{ timestamp: "2026-11-06T09:00:00Z", toolName: "tasks", action: "get", actionClass: "read", result: "error", durationMs: 5, errorMessage: "task not found" },
			{ timestamp: "2026-11-06T10:00:00Z", toolName: "tasks", action: "get", actionClass: "read", result: "error", durationMs: 5, errorMessage: "task not found" },
		];

		await page.route("**/api/audit/analytics*", async (route) => {
			await route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({
					totalCalls: 22,
					byTool: { "tasks.get": 3, "tasks.list": 19 },
					byActionClass: { read: 22 },
					byResult: { success: 19, error: 2, denied: 1 },
					dryRunCount: 0,
					executeCount: 22,
					byToolResult: {},
					timezone: "UTC",
					rangeStart: "2026-11-03",
					rangeEnd: "2026-11-08",
					coverage: { startDate: "2026-11-05", endDate: "2026-11-08", partial: true },
					dailyBuckets: buckets,
					tools: [
						{ tool: "tasks.list", totalCalls: 19, byResult: { success: 19 }, averageDurationMs: 10 },
						{ tool: "tasks.get", totalCalls: 3, byResult: { error: 2, denied: 1 }, averageDurationMs: 14 },
					],
					byProject: {},
					needsAttention: 3,
					averageDurationMs: 12,
				}),
			});
		});
		await page.route("**/api/audit/recent*", async (route) => {
			const url = new URL(route.request().url());
			if (url.searchParams.get("result") === "error") {
				await route.fulfill({ contentType: "application/json", body: JSON.stringify({ count: failing.length, events: failing }) });
			} else if (url.searchParams.get("result") === "denied") {
				await route.fulfill({ contentType: "application/json", body: JSON.stringify({ count: 0, events: [] }) });
			} else {
				await route.continue();
			}
		});

		await page.goto(`${server.baseURL}/audit`);
		await page.getByRole("tab", { name: "Statistics" }).click();

		await test.step("Range summary tiles carry a sparkline each", async () => {
			const summary = page.getByRole("region", { name: "Range summary" });
			await expect(summary).toBeVisible();
			await expect(summary.getByRole("img")).toHaveCount(4);
			// 11-07 is covered but had no calls: the rate and latency lines skip it instead of breaking.
			for (const name of [/Success rate per day/, /Average latency per day/]) {
				const d = await summary.getByRole("img", { name }).locator("path").first().getAttribute("d");
				expect((d ?? "").match(/M/g)).toHaveLength(1);
			}
		});

		await test.step("One chart shows the covered days, and says how many earlier days have no history", async () => {
			await expect(page.getByRole("heading", { name: "Calls per day" })).toBeVisible();
			await expect(page.getByRole("img", { name: /MCP calls per day/ })).toBeVisible();
			await expect(page.getByText("2 earlier days have no retained history.")).toBeVisible();
		});

		await test.step("The chart does not scroll sideways", async () => {
			const section = page.getByRole("region", { name: "Calls per day" }).or(page.locator("section[aria-labelledby='audit-trend-heading']"));
			const overflow = await section.first().evaluate((el) => el.scrollWidth - el.clientWidth);
			expect(overflow).toBeLessThanOrEqual(1);
		});

		await test.step("What needs attention lists the failing tool with its common message", async () => {
			const row = page.getByRole("button", { name: /tasks\.get: 2 errors, 1 denied/ });
			await expect(row).toBeVisible();
			await expect(row).toContainText("task not found");
			await expect(row).toContainText("(2x)");
		});

		await test.step("The busiest day opens Recent Activity filtered to that day", async () => {
			const request = page.waitForRequest((req) => req.url().includes("/api/audit/recent") && req.url().includes("from=2026-11-06"));
			await page.getByRole("button", { name: /Nov 6: 12 calls/ }).click();
			await request;
			await expect(page.getByRole("tab", { name: "Recent Activity" })).toHaveAttribute("aria-selected", "true");
		});

		await test.step("A needs-attention row opens Recent Activity for that tool and result", async () => {
			await page.getByRole("tab", { name: "Statistics" }).click();
			const request = page.waitForRequest((req) => req.url().includes("/api/audit/recent") && req.url().includes("result=error") && req.url().includes("tool=tasks"));
			await page.getByRole("button", { name: /tasks\.get: 2 errors, 1 denied/ }).click();
			await request;
			await expect(page.getByRole("tab", { name: "Recent Activity" })).toHaveAttribute("aria-selected", "true");
		});
	});

	test("an event opens a detail sheet with its arguments", async ({ page }) => {
		await test.step("Create an audited MCP call", async () => {
			server.mcp("tasks", {
				action: "create",
				title: "Detail Sheet Task",
				description: "For verifying event details",
			});
		});

		await test.step("Open the newest tasks.create event", async () => {
			await page.goto(`${server.baseURL}/audit`);
			const row = page.locator('[data-audit-event="tasks.create"]').first();
			await expect(row).toBeVisible({ timeout: 10000 });
			await expect(row.locator("time")).toHaveAttribute("title", /\d/);
			await row.click();
		});

		await test.step("The sheet shows facts, arguments and the raw JSON", async () => {
			const detail = page.getByTestId("audit-event-detail");
			await expect(detail).toBeVisible();
			await expect(detail.getByText("Success", { exact: true })).toBeVisible();
			await expect(detail.getByRole("heading", { name: "Arguments" })).toBeVisible();
			await expect(detail.getByText("Detail Sheet Task").first()).toBeVisible();
			await expect(detail.getByRole("heading", { name: "Raw event" })).toBeVisible();
			await expect(detail.getByText('"toolName"')).toBeVisible();
		});

		await test.step("Escape closes the sheet", async () => {
			await page.keyboard.press("Escape");
			await expect(page.getByTestId("audit-event-detail")).toBeHidden();
		});
	});

	test("search and filters narrow the event list", async ({ page }) => {
		await test.step("Create a read and a write event", async () => {
			server.mcp("tasks", { action: "list" });
			server.mcp("tasks", { action: "create", title: "Searchable Audit Task" });
		});

		await page.goto(`${server.baseURL}/audit`);
		await expect(page.locator("[data-audit-event]").first()).toBeVisible({ timeout: 10000 });

		await test.step("Search matches arguments", async () => {
			await page.getByLabel("Search audit events").fill("Searchable Audit Task");
			const rows = page.locator("[data-audit-event]");
			await expect(rows.first()).toHaveAttribute("data-audit-event", "tasks.create");
			await expect(page.getByText(/^\d+ of \d+ events loaded$/)).toBeVisible();
			await page.getByLabel("Search audit events").fill("no-such-event-anywhere");
			await expect(page.getByText("No loaded events match this search.")).toBeVisible();
			await page.getByLabel("Search audit events").fill("");
		});

		await test.step("The result filter asks the server for errors only", async () => {
			const request = page.waitForRequest((req) => req.url().includes("/api/audit/recent") && req.url().includes("result=error"));
			await page.getByLabel("Filter by result").click();
			await page.getByRole("option", { name: "Error" }).click();
			await request;
			await expect(page.locator('[data-audit-event]').first().or(page.getByText("No audit events match these filters."))).toBeVisible();
		});
	});

	test("refresh button reloads data", async ({ page }) => {
		await test.step("Navigate to audit page", async () => {
			await page.goto(`${server.baseURL}/audit`);
		});

		await test.step("Refresh button is present", async () => {
			const refreshButton = page.getByRole("button", { name: /Refresh audit data/ });
			await expect(refreshButton).toBeVisible();
			await expect(refreshButton).toBeEnabled();
		});

		await test.step("Click refresh", async () => {
			await page.getByRole("button", { name: /Refresh audit data/ }).click();
		});

		await test.step("Page is stable after refresh", async () => {
			await expect(page.getByRole("heading", { name: "MCP Audit Trail" })).toBeVisible();
			await expect(page.getByRole("button", { name: "Refresh audit data" })).toBeEnabled();
		});
	});

	test("failed requests show a useful retry state", async ({ page }) => {
		await page.route("**/api/audit/recent*", async (route) => {
			await route.fulfill({
				status: 503,
				contentType: "application/json",
				body: JSON.stringify({ error: "temporarily unavailable" }),
			});
		});

		await page.goto(`${server.baseURL}/audit`);

		const errorState = page.getByRole("alert");
		await expect(errorState).toContainText("Audit activity unavailable");
		await expect(errorState.getByRole("button", { name: "Try again" })).toBeVisible();
		await expect(
			page.getByRole("region", { name: "Audit status summary" }).getByText("–"),
		).toHaveCount(3);
	});
});
