import { expect, test } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;
let parentId = "";
let childId = "";

test.beforeAll(async () => {
	server = await startServer();
	const mk = async (body: object) => {
		const res = await fetch(`${server.baseURL}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		return (await res.json()) as { id: string };
	};
	parentId = (await mk({ title: "Epic parent task", priority: "medium" })).id;
	childId = (await mk({ title: "Child of the epic", priority: "medium", parent: parentId })).id;
	for (let i = 0; i < 5; i++) await mk({ title: `Filler ${i}`, priority: "low" });
});

test.afterAll(() => server?.cleanup());

test.describe("No page reads the whole task list", () => {
	for (const path of ["/", "/tasks", "/kanban", "/docs"]) {
		test(`${path} only asks for bounded task pages`, async ({ page }) => {
			const unbounded: string[] = [];
			page.on("request", (r) => {
				const u = new URL(r.url());
				if (u.pathname === "/api/tasks" && r.method() === "GET" && !u.searchParams.has("limit")) unbounded.push(u.search || "(none)");
			});
			await page.goto(`${server.baseURL}${path}`);
			await page.waitForTimeout(2500);
			expect(unbounded).toEqual([]);
		});
	}

	test("an open task fetches only its parent and subtasks, and the create form searches on the server", async ({ page }) => {
		const unbounded: string[] = [];
		const queries: string[] = [];
		page.on("request", (r) => {
			const u = new URL(r.url());
			if (u.pathname !== "/api/tasks" || r.method() !== "GET") return;
			if (!u.searchParams.has("limit")) unbounded.push(u.search);
			if (u.searchParams.has("query")) queries.push(u.searchParams.get("query") ?? "");
		});
		await page.goto(`${server.baseURL}/tasks/${childId}`);
		// The parent's title comes from its own request.
		await expect(page.getByText("Epic parent task").first()).toBeVisible();
		await page.goto(`${server.baseURL}/tasks/${parentId}`);
		await expect(page.getByText("Child of the epic").first()).toBeVisible();

		await page.goto(`${server.baseURL}/tasks`);
		await page.getByRole("button", { name: "New Task" }).first().click();
		await page.getByRole("searchbox", { name: "Search parent tasks" }).fill("Epic parent");
		await expect.poll(() => queries.at(-1)).toBe("Epic parent");
		expect(unbounded).toEqual([]);
	});
});
