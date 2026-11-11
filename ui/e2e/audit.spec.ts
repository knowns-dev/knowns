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
