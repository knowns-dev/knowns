import { execFileSync } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

// One server per test: the tray lists every operation of the server, so tests must not see each
// other's rows.
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

type Op = {
	id: string;
	state: string;
	message: string | null;
	error: string | null;
	retryable: boolean;
	progress: { done: number; total: number } | null;
};

async function operations(page: Page): Promise<Op[]> {
	const res = await page.request.get(`${server.baseURL}/api/operations`);
	return ((await res.json()) as { operations: Op[] }).operations;
}

/** Many done tasks fast, through the API (the CLI would take a process each). */
async function doneTasks(page: Page, n: number, prefix = "Bulk"): Promise<string[]> {
	const ids: string[] = [];
	for (let at = 0; at < n; at += 20) {
		const part = await Promise.all(
			Array.from({ length: Math.min(20, n - at) }, async (_, i) => {
				const res = await page.request.post(`${server.baseURL}/api/tasks`, {
					data: { title: `${prefix} ${at + i}`, status: "done" },
				});
				return ((await res.json()) as { id: string }).id;
			}),
		);
		ids.push(...part);
	}
	return ids;
}

async function startBatch(page: Page, ids: string[]): Promise<string> {
	const res = await page.request.post(`${server.baseURL}/api/tasks/batch-archive`, {
		data: { ids, execute: true, background: true },
	});
	expect(res.status()).toBe(202);
	return ((await res.json()) as { operation: { id: string } }).operation.id;
}

async function statusOf(page: Page, id: string): Promise<string> {
	const task = (await (await page.request.get(`${server.baseURL}/api/tasks/${id}`)).json()) as {
		lifecycleState: string;
	};
	return task.lifecycleState;
}

test.describe("Activity tray", () => {
	test("a background batch shows in the tray, finishes and leaves on its own", async ({ page }) => {
		const ids = [1, 2, 3].map((n) => createTask(`Tray done ${n}`, "--status done"));
		await page.goto(`${server.baseURL}/tasks`);
		await expect(page.getByText("Tray done 1").first()).toBeVisible();
		await startBatch(page, ids);

		const tray = page.getByTestId("activity-tray");
		await expect(tray).toContainText("Archiving 3 tasks");
		await expect(tray).toContainText("3 archived");
		// The stack's one timer takes a finished row away (about 4 s), without any request.
		await expect(tray).toBeHidden({ timeout: 10_000 });
		// Hidden in this tab only: the server still lists it until its own expiry.
		expect((await operations(page)).some((o) => o.state === "done")).toBe(true);
	});

	test("the tray sits top right under the header and never overlaps a toast", async ({ page }) => {
		const open = createTask("Layout still open", "--status in-progress");
		const done = createTask("Layout finishable", "--status done");
		await page.goto(`${server.baseURL}/tasks`);
		await startBatch(page, [done, open]);
		const tray = page.getByTestId("activity-tray");
		await expect(tray).toContainText("not changed");

		// A toast at the same time: creating a Task from the UI shows "Task created".
		await page.getByRole("button", { name: /new task/i }).first().click();
		await page.getByPlaceholder(/title/i).first().fill("Toast Task");
		await page.getByRole("button", { name: /create task/i }).click();
		const toast = page.locator("ol[aria-live=polite] li").first();
		await expect(toast).toBeVisible();

		const header = await page.locator("header").first().boundingBox();
		const box = await tray.boundingBox();
		const toastBox = await toast.boundingBox();
		const view = page.viewportSize();
		if (!header || !box || !toastBox || !view) throw new Error("layout boxes missing");
		expect(box.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
		expect(box.x + box.width).toBeGreaterThan(view.width - 40); // right side
		expect(box.y).toBeLessThan(view.height / 2); // top half
		const apart =
			box.x + box.width <= toastBox.x ||
			toastBox.x + toastBox.width <= box.x ||
			box.y + box.height <= toastBox.y ||
			toastBox.y + toastBox.height <= box.y;
		expect(apart).toBe(true);
	});

	test("confirming the archive dialog closes it, no toast says so, and the tray follows done / total", async ({ page }) => {
		const ids = await doneTasks(page, 200, "Dialog");
		expect(ids).toHaveLength(200);
		await page.goto(`${server.baseURL}/kanban`);
		await page.getByRole("button", { name: "Archive completed Tasks" }).click();
		await page.getByRole("menuitem", { name: /Done before now/ }).click();
		const dialog = page.getByTestId("task-lifecycle-dialog");
		await expect(dialog).toBeVisible();
		await dialog.getByTestId("lifecycle-confirm").click();
		await expect(dialog).toBeHidden();
		// No "in the background" toast: the tray itself is the feedback.
		await expect(page.getByText(/in the background/i)).toHaveCount(0);

		const tray = page.getByTestId("activity-tray");
		await expect(tray).toContainText("Archiving 200 tasks");
		const seen = new Set<string>();
		const end = Date.now() + 30_000;
		while (Date.now() < end) {
			const text = (await tray.textContent().catch(() => null)) ?? "";
			const m = /(\d+)\s*\/\s*200/.exec(text);
			if (m?.[1]) seen.add(m[1]);
			if (/200 archived/.test(text)) break;
			await page.waitForTimeout(40);
		}
		expect(seen.size).toBeGreaterThanOrEqual(2);
		await expect(tray).toContainText("200 archived");
	});

	test("Cancel stops the batch with 'N archived, M left', untouched tasks stay done, and Run again finishes the rest", async ({ page }) => {
		const ids = await doneTasks(page, 150, "Cancel");
		await page.goto(`${server.baseURL}/tasks`);
		const id = await startBatch(page, ids);
		const tray = page.getByTestId("activity-tray");
		await expect(tray).toContainText("Archiving 150 tasks");
		await tray.getByText("Archiving 150 tasks").click();
		await tray.getByRole("button", { name: "Cancel" }).click();

		await expect.poll(async () => (await operations(page)).find((o) => o.id === id)?.state, { timeout: 30_000 }).toBe("cancelled");
		const op = (await operations(page)).find((o) => o.id === id) as Op;
		const m = /^(\d+) archived, (\d+) left/.exec(op.message ?? "");
		expect(m).not.toBeNull();
		const archived = Number(m?.[1]);
		const left = Number(m?.[2]);
		expect(archived + left).toBe(150);
		expect(left).toBeGreaterThan(0);
		await expect(tray).toContainText(`${archived} archived, ${left} left`);

		// Exactly the processed ones are archived; the untouched ones are still done.
		const states = await Promise.all(ids.map((tid) => statusOf(page, tid)));
		expect(states.filter((s) => s === "archived")).toHaveLength(archived);
		expect(states.filter((s) => s === "done")).toHaveLength(left);

		// A cancelled row with work left is not aged out by the timer.
		await page.waitForTimeout(5500);
		await expect(tray).toBeVisible();
		await expect(tray).toContainText("left");

		// Run again takes only what is left, and finishes.
		await tray.getByText(/Archiving 150 tasks/).first().click();
		await tray.getByRole("button", { name: "Run again" }).click();
		await expect.poll(async () => {
			const all = await Promise.all(ids.map((tid) => statusOf(page, tid)));
			return all.filter((s) => s === "archived").length;
		}, { timeout: 60_000 }).toBe(150);
		const again = (await operations(page)).find((o) => o.id !== id && o.state === "done");
		expect(again?.progress?.total).toBe(left);
	});

	test("a partly failed batch stays with its reasons, a Runtime link and Run again; Dismiss removes it on the server", async ({ page }) => {
		const open = createTask("Tray still open", "--status in-progress");
		const done = createTask("Tray finishable", "--status done");
		await page.goto(`${server.baseURL}/tasks`);
		const id = await startBatch(page, [done, open]);

		const tray = page.getByTestId("activity-tray");
		await expect(tray).toContainText("Archiving 2 tasks");
		// The reason is on the collapsed line already (before the card is opened).
		await expect(tray).toContainText("1 archived, 1 not changed");
		await expect(tray).toContainText(`#${open}`);
		const link = tray.getByRole("link", { name: "Open Runtime" });
		await expect(link).toHaveAttribute("href", "/runtime");
		await tray.getByText("Archiving 2 tasks").click();
		await expect(tray.getByRole("button", { name: "Run again" })).toBeVisible();
		// A failed row does not age out.
		await page.waitForTimeout(5000);
		await expect(tray).toBeVisible();

		await link.click();
		await expect(page).toHaveURL(/\/runtime$/);

		await tray.getByRole("button", { name: "Dismiss" }).click();
		await expect(tray).toBeHidden();
		await expect.poll(async () => (await operations(page)).some((o) => o.id === id)).toBe(false);
	});

	test("a reload takes the snapshot back: a failed row is still there", async ({ page }) => {
		const open = createTask("Tray reload open", "--status in-progress");
		const done = createTask("Tray reload done", "--status done");
		await page.goto(`${server.baseURL}/tasks`);
		await startBatch(page, [done, open]);
		await expect(page.getByTestId("activity-tray")).toContainText("Archiving 2 tasks");
		await page.reload();
		await expect(page.getByTestId("activity-tray")).toContainText("Archiving 2 tasks");
	});

	test("a reload while a batch is RUNNING shows its current progress, then it finishes", async ({ page }) => {
		const ids = await doneTasks(page, 400, "Running");
		await page.goto(`${server.baseURL}/tasks`);
		const id = await startBatch(page, ids);
		await expect.poll(async () => (await operations(page)).find((o) => o.id === id)?.progress?.done ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
		await page.reload();
		const tray = page.getByTestId("activity-tray");
		await expect(tray).toContainText("Archiving 400 tasks");
		await expect(tray).toContainText(/[1-9]\d* \/ 400|400 archived/);
		await expect(tray).toContainText("400 archived", { timeout: 60_000 });
	});

	test("no polling: an idle tray makes one snapshot request (at connect) and nothing after", async ({ page }) => {
		let snapshots = 0;
		page.on("request", (r) => {
			if (r.method() === "GET" && new URL(r.url()).pathname === "/api/operations") snapshots++;
		});
		await page.goto(`${server.baseURL}/tasks`);
		await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
		await page.waitForTimeout(30_000);
		expect(snapshots).toBe(1);
	});

	test("idle: with the UI open and the tray mounted but empty, the server stays under the idle CPU budget", async ({ page }) => {
		test.skip(process.platform === "win32", "ps is not on Windows; the proxy budget script measures it there");
		const pid = server.pid;
		if (!pid) throw new Error("no server pid");
		await page.goto(`${server.baseURL}/tasks`);
		await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
		await page.waitForTimeout(2000); // let the page settle

		// The same method as scripts/proxy-budget.ts: cumulative CPU seconds of the process over a window.
		const cpuSeconds = (): number => {
			const out = execFileSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }).trim();
			const [s = 0, m = 0, h = 0, d = 0] = out.split(/[:-]/).map(Number).reverse();
			return s + m * 60 + h * 3600 + d * 86400;
		};
		const a = cpuSeconds();
		const t0 = Date.now();
		await page.waitForTimeout(15_000);
		const pct = ((cpuSeconds() - a) / ((Date.now() - t0) / 1000)) * 100;
		const limit = process.env.CI ? 3 : 1;
		expect(pct).toBeLessThanOrEqual(limit);
	});

	test("with reduced motion every animation and transition in the tray ends at once and the state is right", async ({ page }) => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		const open = createTask("Tray rm open", "--status in-progress");
		const done = createTask("Tray rm done", "--status done");
		await page.goto(`${server.baseURL}/tasks`);
		await startBatch(page, [done, open]);
		const tray = page.getByTestId("activity-tray");
		await expect(tray).toContainText("not changed");
		await tray.getByText("Archiving 2 tasks").click();

		const offenders = await tray.evaluate((root) => {
			const secs = (v: string) => v.split(",").map((x) => (x.trim().endsWith("ms") ? Number.parseFloat(x) / 1000 : Number.parseFloat(x)));
			const bad: string[] = [];
			for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
				const cs = getComputedStyle(el);
				const animating = cs.animationName !== "none" && secs(cs.animationDuration).some((d) => d > 0.001);
				const transitioning = secs(cs.transitionDuration).some((d) => d > 0.001);
				if (animating || transitioning) bad.push(`${el.tagName}.${el.getAttribute("class")?.slice(0, 60)} anim=${cs.animationName}/${cs.animationDuration} trans=${cs.transitionDuration}`);
			}
			return bad;
		});
		expect(offenders).toEqual([]);
		await expect(tray).toContainText("1 archived, 1 not changed");
	});
});
