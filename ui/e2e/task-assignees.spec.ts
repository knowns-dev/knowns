// D13 (TSR-HF118X): filter and group Tasks by assignee, ported from contributor PR #156.
import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
	server.cli('task create "Alice first" -a @alice');
	server.cli('task create "Alice second" -a @alice');
	server.cli('task create "Bob only" -a @bob');
	server.cli('task create "Nobody owns this"');
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Tasks by assignee", () => {
	test("filters the list by a person and by Unassigned", async ({ page }) => {
		await page.goto(`${server.baseURL}/tasks`);
		// The list loads after the shell; wait for it before reading the filter options.
		await expect(page.getByText("Nobody owns this")).toBeVisible({ timeout: 20_000 });
		// The filter is the Knowns UI combobox: a button that opens a listbox of options.
		const filter = page.locator("#task-assignee-filter");
		const pick = async (name: RegExp) => {
			await filter.click();
			await page.getByRole("listbox").getByRole("option", { name }).click();
		};

		await test.step("options carry per-person counts, Unassigned last", async () => {
			await filter.click();
			// Each row is label + count as separate spans (plus avatar initials), so match patterns in order.
			await expect(page.getByRole("listbox").getByRole("option")).toHaveText([
				/All assignees\s*4 tasks/,
				/@alice\s*2 tasks/,
				/@bob\s*1 task/,
				/Unassigned\s*1 task/,
			]);
			await page.keyboard.press("Escape");
		});

		await test.step("a person shows only their Tasks", async () => {
			await pick(/^@alice/);
			await expect(page.getByText("Alice first")).toBeVisible();
			await expect(page.getByText("Alice second")).toBeVisible();
			await expect(page.getByText("Bob only")).toHaveCount(0);
			await expect(page.getByText("Nobody owns this")).toHaveCount(0);
			await expect(page.locator("span.tabular-nums").first()).toHaveText("2 tasks");
		});

		await test.step("Unassigned shows only Tasks without an assignee", async () => {
			await pick(/^Unassigned/);
			await expect(page.getByText("Nobody owns this")).toBeVisible();
			await expect(page.getByText("Alice first")).toHaveCount(0);
			await expect(page.locator("span.tabular-nums").first()).toHaveText("1 task");
		});
	});

	test("groups the grouped view by assignee", async ({ page }) => {
		await page.goto(`${server.baseURL}/tasks`);
		await page.getByRole("button", { name: "Grouped view" }).click();
		await page.getByRole("combobox", { name: "Group by" }).click();
		await page.getByRole("option", { name: "Group by Assignee" }).click();

		const headings = page.getByRole("heading", { level: 2 });
		await expect(headings).toHaveText([/^@alice\s*2$/, /^@bob\s*1$/, /^Unassigned\s*1$/]);
	});
});
