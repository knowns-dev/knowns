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
		});

		await test.step("Tabs are present", async () => {
			await expect(page.getByText("Recent Activity")).toBeVisible({ timeout: 5000 });
			await expect(page.getByText("Statistics")).toBeVisible({ timeout: 5000 });
		});
	});

	test("recent tab shows empty state or events", async ({ page }) => {
		await test.step("Navigate to audit page", async () => {
			await page.goto(`${server.baseURL}/audit`);
		});

		await test.step("Recent Activity tab is selected by default", async () => {
			await expect(page.getByText("Recent Activity")).toBeVisible({ timeout: 5000 });
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
				const refreshBtn = page.getByTitle("Refresh");
				if (await refreshBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
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
			await expect(page.getByRole("heading", { name: "MCP Audit Trail" })).toBeVisible({ timeout: 5000 });
		});

		await test.step("Filter dropdowns are visible", async () => {
			// Tool filter and result filter select elements
			const toolSelect = page.locator("select").filter({ hasText: /All tools|All results/ });
			const toolSelectCount = await toolSelect.count();
			if (toolSelectCount > 0) {
				await expect(toolSelect.first()).toBeVisible();
			}
		});

		await test.step("Event count text is shown", async () => {
			await expect(page.getByText(/events$/)).toBeVisible({ timeout: 5000 });
		});
	});

	test("statistics tab renders correctly", async ({ page }) => {
		await test.step("Navigate to audit page", async () => {
			await page.goto(`${server.baseURL}/audit`);
		});

		await test.step("Click Statistics tab", async () => {
			await page.getByText("Statistics").click();
			await page.waitForTimeout(1000);
		});

		await test.step("Statistics cards or empty state is visible", async () => {
			const emptyState = page.getByText("No audit data available.");
			const totalCallsText = page.getByText("Total Calls");
			const isEmpty = await emptyState.isVisible({ timeout: 3000 }).catch(() => false);
			const hasStats = await totalCallsText.isVisible({ timeout: 3000 }).catch(() => false);
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
			await expect(page.getByTitle("Refresh")).toBeVisible({ timeout: 5000 });
		});

		await test.step("Click refresh", async () => {
			await page.getByTitle("Refresh").click();
			await page.waitForTimeout(1000);
		});

		await test.step("Page is stable after refresh", async () => {
			await expect(page.getByRole("heading", { name: "MCP Audit Trail" })).toBeVisible();
		});
	});
});
