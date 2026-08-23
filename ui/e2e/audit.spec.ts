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
			const eventRows = page.locator(".space-y-1 > div").first();
			// Wait for loading to finish
			await page.waitForTimeout(2000);
			const isEmptyVisible = await emptyState.isVisible({ timeout: 3000 }).catch(() => false);
			const hasEvents = await eventRows.isVisible({ timeout: 3000 }).catch(() => false);
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
			const isEmpty = await emptyState.isVisible({ timeout: 2000 }).catch(() => false);
			if (isEmpty) {
				// Refresh button is available
				const refreshBtn = page.getByRole("button", { name: /Refresh audit data/ });
				if (await refreshBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
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
			const isEmpty = await emptyState.isVisible({ timeout: 3000 }).catch(() => false);
			const hasStats = await rangeSummary.isVisible({ timeout: 3000 }).catch(() => false);
			expect(isEmpty || hasStats).toBeTruthy();
		});
	});

	test("event rows show expandable details", async ({ page }) => {
		await test.step("Ensure events exist", async () => {
			server.cli('task create "Detail Check Task" -d "For verifying event details"');
		});

		await test.step("Navigate to audit page", async () => {
			await page.goto(`${server.baseURL}/audit`);
		});

		await test.step("Wait for events to load", async () => {
			await page.waitForTimeout(2000);
		});

		await test.step("Event rows are interactive", async () => {
			// Check that event row elements exist (contain ts/tool/result)
			const eventElements = page.locator(".space-y-1 > div");
			const count = await eventElements.count();
			if (count > 0) {
				// First event row should show tool name in font-mono text
				const firstEvent = eventElements.first();
				await expect(firstEvent).toBeVisible();
				// Try clicking the first event to expand (if it has details)
				await firstEvent.click({ timeout: 2000 }).catch(() => {});
				await page.waitForTimeout(300);
			}
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
			page.getByRole("region", { name: "Audit status summary" }).getByText("—"),
		).toHaveCount(3);
	});
});
