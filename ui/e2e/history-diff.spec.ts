import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("History shows readable diffs", () => {
	test("task history summarises changed fields and shows a word diff for prose", async ({ page }) => {
		const output = server.cli('task create "Prose Task" -d "The quick brown fox jumps" --priority low');
		const taskId = output.match(/Created task\s+([a-z0-9-]+)/i)?.[1] || "";
		server.cli(`task edit ${taskId} -d "The slow brown fox sleeps"`);
		server.cli(`task edit ${taskId} --priority high`);

		await page.goto(`${server.baseURL}/kanban/${taskId}`);
		const dialog = page.locator('[role="dialog"]');
		await dialog.getByRole("tab", { name: "Activity" }).click();
		const history = dialog.getByRole("region", { name: "History" });
		await expect(history).toBeVisible();

		// The newest version changed the priority only: a summary of one field.
		await history.getByRole("option").first().click();
		await expect(history.getByText(/1 field changed/)).toBeVisible();

		// The description edit reads as removed and added words.
		await history.getByRole("option").nth(1).click();
		const prose = history.getByTestId("prose-diff");
		await expect(prose).toBeVisible();
		await expect(prose.locator("del", { hasText: "quick" })).toBeVisible();
		await expect(prose.locator("ins", { hasText: "slow" })).toBeVisible();
		// Read-only: no accept or reject controls.
		await expect(history.getByRole("button", { name: /accept|reject/i })).toHaveCount(0);
	});

	test("doc history shows a word diff and can compare two versions", async ({ page }) => {
		server.cli('doc create "History Diff Doc" -d "Doc for history" -c "Pelicans eat fish."');
		server.cli('doc edit "history-diff-doc" -c "Pelicans eat bread."');
		server.cli('doc edit "history-diff-doc" -c "Pelicans eat bread daily."');

		await page.goto(`${server.baseURL}/docs/history-diff-doc.md`);
		await page.getByTitle("Document history").click();
		const sheet = page.getByRole("dialog");
		await expect(sheet.getByText("Document history")).toBeVisible();

		const prose = sheet.getByTestId("prose-diff");
		await expect(prose).toBeVisible();
		await expect(prose.locator("ins")).toContainText("daily");

		// Compare the newest version with the oldest one.
		await sheet.getByRole("combobox", { name: "Compare with version" }).click();
		await page.getByRole("option", { name: /^v1$/ }).click();
		await expect(sheet.getByTestId("prose-diff").locator("del")).toContainText("fish");
		await expect(sheet.getByTestId("prose-diff").locator("ins")).toContainText("bread");
	});
});
