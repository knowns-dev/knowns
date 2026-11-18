import { expect, test, type Page } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

async function createTask(title: string, status = "todo"): Promise<void> {
	const res = await fetch(`${server.baseURL}/api/tasks`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ title, status, priority: "medium" }),
	});
	if (!res.ok) throw new Error(`create ${title}: ${res.status} ${await res.text()}`);
}

const TOTAL = 130;

test.beforeAll(async () => {
	server = await startServer();
	for (let i = 0; i < TOTAL; i++) await createTask(`Paged task ${String(i).padStart(3, "0")}`);
});

test.afterAll(() => {
	server?.cleanup();
});

function listRows(page: Page) {
	return page.locator('[data-testid="task-list-view"] tbody tr');
}

test.describe("Server-paged Tasks list", () => {
	test("the first request is one page; scrolling to the end loads the next with skeletons, never twice, and stops when done", async ({ page }) => {
		const pages: string[] = [];
		page.on("request", (r) => {
			const u = new URL(r.url());
			if (u.pathname === "/api/tasks" && r.method() === "GET") pages.push(u.search);
		});
		await page.goto(`${server.baseURL}/tasks`);
		await page.getByRole("button", { name: "List view" }).click();
		await expect(listRows(page).first()).toBeVisible();

		// One page of 50 to start (and no full list anywhere on the page).
		await expect.poll(() => listRows(page).count()).toBe(50);
		expect(pages.every((q) => q.includes("limit=50") && q.includes("summary=true"))).toBe(true);
		expect(pages.some((q) => !q.includes("limit="))).toBe(false);

		// Scroll to the sentinel: the next page arrives, then the last one.
		for (const want of [100, TOTAL]) {
			await page.locator('[data-testid="infinite-sentinel"]').first().scrollIntoViewIfNeeded();
			await expect.poll(() => listRows(page).count(), { timeout: 15_000 }).toBe(want);
		}
		// Exhausted: no sentinel, no further request.
		await expect(page.locator('[data-testid="infinite-sentinel"]')).toHaveCount(0);
		const before = pages.length;
		await page.waitForTimeout(500);
		expect(pages.length).toBe(before);

		// No duplicate rows.
		const ids = await listRows(page).evaluateAll((rows) => rows.map((r) => r.textContent?.match(/#([A-Z0-9-]+)/)?.[1]));
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("shows skeletons while a page is in flight and an error with Retry when it fails", async ({ page }) => {
		let mode: "hold" | "fail" | "pass" = "hold";
		let release: (() => void) | undefined;
		await page.route((u) => u.pathname === "/api/tasks", async (route) => {
			if (!new URL(route.request().url()).searchParams.get("cursor")) return route.continue();
			if (mode === "fail") return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
			if (mode === "hold") await new Promise<void>((resolve) => { release = resolve; });
			return route.continue();
		});
		await page.goto(`${server.baseURL}/tasks`);
		await page.getByRole("button", { name: "List view" }).click();
		await expect.poll(() => listRows(page).count()).toBe(50);

		// While the second page is in flight the list is busy and shows skeleton rows.
		await page.locator('[data-testid="infinite-sentinel"]').first().scrollIntoViewIfNeeded();
		await expect(page.locator('[aria-busy="true"]').first()).toBeVisible();
		await expect.poll(() => release !== undefined).toBe(true);
		mode = "pass";
		release?.();
		await expect.poll(() => listRows(page).count()).toBe(100);

		// A failing last page keeps the rows and offers Retry.
		mode = "fail";
		await page.locator('[data-testid="infinite-sentinel"]').first().scrollIntoViewIfNeeded();
		await expect(page.getByRole("alert").getByRole("button", { name: "Retry" })).toBeVisible();
		await expect(listRows(page)).toHaveCount(100);
		mode = "pass";
		await page.getByRole("button", { name: "Retry" }).click();
		await expect.poll(() => listRows(page).count(), { timeout: 15_000 }).toBe(TOTAL);
	});

	test("search runs on the server", async ({ page }) => {
		const queries: string[] = [];
		page.on("request", (r) => {
			const u = new URL(r.url());
			if (u.pathname === "/api/tasks" && u.searchParams.has("query")) queries.push(u.searchParams.get("query") ?? "");
		});
		await page.goto(`${server.baseURL}/tasks`);
		await page.getByRole("button", { name: "List view" }).click();
		await page.getByRole("searchbox", { name: "Search Tasks" }).fill("Paged task 077");
		await expect.poll(() => listRows(page).count()).toBe(1);
		expect(queries.at(-1)).toBe("Paged task 077");
	});

	test("an SSE update inserts a new task at the top without resetting the scroll", async ({ page }) => {
		await page.goto(`${server.baseURL}/tasks`);
		await page.getByRole("button", { name: "List view" }).click();
		await expect.poll(() => listRows(page).count()).toBe(50);
		await page.locator('[data-testid="infinite-sentinel"]').first().scrollIntoViewIfNeeded();
		await expect.poll(() => listRows(page).count()).toBe(100);

		await createTask("Brand new live task");
		await expect(page.getByText("Brand new live task")).toBeAttached();
		await expect.poll(() => listRows(page).count()).toBe(101);
		await expect(listRows(page).first()).toContainText("Brand new live task");
	});
});

test.describe("Server-paged Board columns", () => {
	test("each column loads 20 cards and the next 20 as its own scroll nears the end", async ({ page }) => {
		const calls: string[] = [];
		page.on("request", (r) => {
			const u = new URL(r.url());
			if (u.pathname === "/api/tasks" && r.method() === "GET") calls.push(u.search);
		});
		await page.goto(`${server.baseURL}/kanban`);
		await expect(page.locator("span.font-mono", { hasText: /^#/ }).first()).toBeVisible();
		await expect.poll(() => page.locator("span.font-mono", { hasText: /^#/ }).count()).toBe(20);
		expect(calls.some((q) => q.includes("status=todo") && q.includes("sort=order") && q.includes("limit=20"))).toBe(true);
		// The column badge carries the server count, not the loaded 20.
		await expect(page.getByRole("button", { name: /To Do\s*1[3-9]\d/ })).toBeVisible();

		await page.locator('[data-testid="infinite-sentinel"]').first().scrollIntoViewIfNeeded();
		await expect.poll(() => page.locator("span.font-mono", { hasText: /^#/ }).count(), { timeout: 15_000 }).toBe(40);
	});
});
