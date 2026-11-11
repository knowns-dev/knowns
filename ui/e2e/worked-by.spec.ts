import { test, expect } from "@playwright/test";
import { boardCard, startServer, type TestServer } from "./helpers";

// KN-4FQN0P (spec D15): the board and the task detail show which MCP agent is working on a task, while the
// assignee stays the accountable person. The MCP process ends after each call here, so the claim is kept
// alive by a running timer, as it is for a real session.

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

function createTask(title: string): string {
	const out = server.cli(`task create "${title}" -a @owner`);
	const id = out.match(/([A-Z]{2,8}-[0-9A-Z]{6})/)?.[1];
	if (!id) throw new Error(`no task id in: ${out}`);
	return id;
}

test.describe("Worked by agent", () => {
	test("shows the agent on the card and in the detail while its timer runs", async ({ page }) => {
		const id = createTask("Agent Worked Task");
		server.mcp("tasks", { action: "update", taskId: id, status: "in-progress" }, "claude-code");
		server.mcp("time", { action: "start", taskId: id }, "claude-code");

		await page.goto(`${server.baseURL}/kanban`);
		const card = boardCard(page, "Agent Worked Task");
		await expect(card.getByTestId("worked-by")).toContainText("Claude Code");
		await expect(card).toHaveAttribute("aria-label", "Agent Worked Task");

		await card.click();
		const dialog = page.locator('[role="dialog"]');
		await expect(dialog.getByTestId("worked-by")).toContainText("Claude Code");
		// The accountable person is unchanged.
		await expect(dialog.getByText("@owner").first()).toBeVisible();
	});

	test("the agent disappears when its timer stops", async ({ page }) => {
		const id = createTask("Agent Stopped Task");
		server.mcp("tasks", { action: "update", taskId: id, status: "in-progress" }, "codex");
		server.mcp("time", { action: "start", taskId: id }, "codex");
		await page.goto(`${server.baseURL}/kanban`);
		await expect(boardCard(page, "Agent Stopped Task").getByTestId("worked-by")).toContainText("Codex");
		server.mcp("time", { action: "stop", taskId: id }, "codex");
		await page.reload();
		await expect(boardCard(page, "Agent Stopped Task")).toBeVisible();
		await expect(boardCard(page, "Agent Stopped Task").getByTestId("worked-by")).toHaveCount(0);
	});

	test("a client that is not a known agent leaves no trace", async ({ page }) => {
		const id = createTask("Plain Client Task");
		server.mcp("tasks", { action: "update", taskId: id, status: "in-progress" }, "e2e-test");
		server.mcp("time", { action: "start", taskId: id }, "e2e-test");
		await page.goto(`${server.baseURL}/kanban`);
		await expect(boardCard(page, "Plain Client Task")).toBeVisible();
		await expect(boardCard(page, "Plain Client Task").getByTestId("worked-by")).toHaveCount(0);
	});
});
