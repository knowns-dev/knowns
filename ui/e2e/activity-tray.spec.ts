import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

// One server per test: the tray lists every operation of the server, so tests must not see each other's rows.
test.beforeEach(async () => {
	server = await startServer();
});

test.afterEach(() => {
	server?.cleanup();
});

function createTask(title: string, extra = ""): string {
	const output = server.cli(`task create "${title}" ${extra}`);
	return output.match(/Created task\s+([a-z0-9-]+)/i)?.[1] || "";
}

type Op = { id: string; state: string; message: string | null; error: string | null };

async function operations(page: import("@playwright/test").Page): Promise<Op[]> {
	const res = await page.request.get(`${server.baseURL}/api/operations`);
	return ((await res.json()) as { operations: Op[] }).operations;
}

test.describe("Activity tray", () => {
	test("a background batch shows in the tray, finishes and leaves on its own", async ({ page }) => {
		const ids = [1, 2, 3].map((n) => createTask(`Tray done ${n}`, "--status done"));
		await page.goto(`${server.baseURL}/tasks`);
		await expect(page.getByText("Tray done 1").first()).toBeVisible();

		const res = await page.request.post(`${server.baseURL}/api/tasks/batch-archive`, {
			data: { ids, execute: true, background: true },
		});
		expect(res.status()).toBe(202);

		const tray = page.getByTestId("activity-tray");
		await expect(tray).toContainText("Archiving 3 tasks");
		await expect(tray).toContainText("3 archived");
		// The stack's one timer takes a finished row away (about 4 s), without any request.
		await expect(tray).toBeHidden({ timeout: 10_000 });
		// Hidden in this tab only: the server still lists it until its own expiry.
		const ops = await operations(page);
		expect(ops.some((o) => o.state === "done")).toBe(true);
	});

	test("a partly failed batch stays with its reasons and Run again; Dismiss removes it on the server", async ({ page }) => {
		const open = createTask("Tray still open", "--status in-progress");
		const done = createTask("Tray finishable", "--status done");
		await page.goto(`${server.baseURL}/tasks`);

		const res = await page.request.post(`${server.baseURL}/api/tasks/batch-archive`, {
			data: { ids: [done, open], execute: true, background: true },
		});
		expect(res.status()).toBe(202);
		const id = ((await res.json()) as { operation: { id: string } }).operation.id;

		const tray = page.getByTestId("activity-tray");
		await expect(tray).toContainText("Archiving 2 tasks");
		await tray.getByText("Archiving 2 tasks").click();
		await expect(tray).toContainText("1 archived, 1 not changed");
		await expect(tray).toContainText(`#${open}`);
		await expect(tray.getByRole("button", { name: "Run again" })).toBeVisible();
		// A failed row does not age out.
		await page.waitForTimeout(5000);
		await expect(tray).toBeVisible();

		await tray.getByRole("button", { name: "Dismiss" }).click();
		await expect(tray).toBeHidden();
		await expect.poll(async () => (await operations(page)).some((o) => o.id === id)).toBe(false);
	});

	test("a reload takes the snapshot back: a failed row is still there", async ({ page }) => {
		const open = createTask("Tray reload open", "--status in-progress");
		const done = createTask("Tray reload done", "--status done");
		await page.goto(`${server.baseURL}/tasks`);
		await page.request.post(`${server.baseURL}/api/tasks/batch-archive`, {
			data: { ids: [done, open], execute: true, background: true },
		});
		const tray = page.getByTestId("activity-tray");
		await expect(tray).toContainText("Archiving 2 tasks");
		await page.reload();
		await expect(page.getByTestId("activity-tray")).toContainText("Archiving 2 tasks");
	});

	test("with reduced motion the tray still shows the right state at once", async ({ page }) => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		const open = createTask("Tray rm open", "--status in-progress");
		await page.goto(`${server.baseURL}/tasks`);
		const res = await page.request.post(`${server.baseURL}/api/tasks/batch-archive`, {
			data: { ids: [open], execute: true, background: true },
		});
		expect(res.status()).toBe(202);
		await expect(page.getByTestId("activity-tray")).toContainText("Archiving 1 task");
		await expect(page.getByTestId("activity-tray")).toContainText("not changed");
	});
});
