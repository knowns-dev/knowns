// Nested overlays: selects, pickers and popovers opened inside the task create form and the task detail sheet
// (native modal <dialog>s) must open, be clickable, and close one layer per Escape.
import { test, expect, type Page } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;
let detailID = "";

test.beforeAll(async () => {
	server = await startServer();
	server.cli('task create "Overlay Parent Seed" -d "Picked as a parent from the create form"');
	const out = server.cli('task create "Overlay Detail Task" -d "Edited through nested overlays"');
	detailID = out.match(/Created task\s+([a-z0-9-]+)/i)?.[1] || "";
});

test.afterAll(() => {
	server?.cleanup();
});

async function findTask(page: Page, title: string) {
	const res = await page.request.get(`${server.baseURL}/api/tasks`);
	const body = await res.json();
	const list = (Array.isArray(body) ? body : body.tasks) as { id: string; title: string; status: string; priority: string; parent?: string; assignee?: string }[];
	return list.find((t) => t.title === title);
}

test.describe("Nested overlays", () => {
	test("create form: select, searchable parent picker and assignee picker work inside the form", async ({ page }) => {
		await page.goto(`${server.baseURL}/kanban`);
		await page.getByRole("button", { name: /new task/i }).click();
		const form = page.getByRole("dialog", { name: "New task" });
		await expect(form).toBeVisible();
		await page.getByPlaceholder("Enter task title...").fill("Overlay Created Child");

		await test.step("priority select picks", async () => {
			await form.getByLabel("Priority", { exact: true }).selectOption("high");
			await expect(form.getByLabel("Priority", { exact: true })).toHaveValue("high");
		});

		await test.step("Escape closes only the open list, not the form", async () => {
			await form.getByRole("combobox", { name: "Parent task", exact: true }).click();
			await expect(page.getByRole("combobox", { name: /Search Parent task/ })).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(page.getByRole("combobox", { name: /Search Parent task/ })).toBeHidden();
			await expect(form).toBeVisible();
		});

		await test.step("parent picker searches and picks", async () => {
			await form.getByRole("combobox", { name: "Parent task", exact: true }).click();
			await page.getByRole("combobox", { name: /Search Parent task/ }).fill("Parent Seed");
			await page.getByRole("option", { name: /Overlay Parent Seed/ }).click();
			await expect(form.getByRole("combobox", { name: "Parent task", exact: true })).toHaveText(/Overlay Parent Seed/);
		});

		await test.step("assignee picker adds a typed handle", async () => {
			await form.getByRole("combobox").filter({ hasText: /Select assignee/ }).click();
			await page.getByRole("combobox", { name: "Search assignee" }).fill("carol");
			await page.keyboard.press("Enter");
			await expect(form.getByRole("combobox").filter({ hasText: "@carol" })).toBeVisible();
		});

		await page.getByRole("button", { name: "Create Task" }).click();
		await expect(form).toBeHidden();
		await expect
			.poll(async () => {
				const t = await findTask(page, "Overlay Created Child");
				return t ? `${t.priority}|${t.assignee}|${t.parent ? "parent" : "none"}` : "";
			})
			.toBe("high|@carol|parent");
	});

	test("task detail sheet: select inside picks, and Escape closes one layer at a time", async ({ page }) => {
		expect(detailID).not.toBe("");
		await page.goto(`${server.baseURL}/kanban/${detailID}`);
		await expect(page.getByRole("heading", { name: "Overlay Detail Task", exact: true })).toBeVisible();
		const sheet = page.locator('[role="dialog"]').filter({ has: page.getByRole("heading", { name: "Overlay Detail Task", exact: true }) });

		await test.step("status select inside the sheet saves", async () => {
			await sheet.getByRole("combobox", { name: "Status", exact: true }).first().click();
			await page.getByRole("listbox", { name: "Status" }).getByRole("option", { name: /In Progress/ }).click();
			await expect(sheet.getByRole("combobox", { name: "Status", exact: true }).first()).toHaveText(/In Progress/);
			await expect.poll(async () => (await findTask(page, "Overlay Detail Task"))?.status).toBe("in-progress");
		});

		await test.step("Escape closes the open list first, then the sheet", async () => {
			await sheet.getByRole("combobox", { name: "Priority", exact: true }).first().click();
			await expect(page.getByRole("listbox", { name: "Priority" })).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(page.getByRole("listbox", { name: "Priority" })).toBeHidden();
			await expect(sheet).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(sheet).toBeHidden();
		});
	});
});
