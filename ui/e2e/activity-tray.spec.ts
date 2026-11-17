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

/** The lifecycle state of many tasks, a few requests at a time (600 at once overruns the listener). */
async function statesOf(page: Page, ids: string[]): Promise<string[]> {
	const out: string[] = [];
	for (let at = 0; at < ids.length; at += 20) out.push(...(await Promise.all(ids.slice(at, at + 20).map((id) => statusOf(page, id)))));
	return out;
}

async function statusOf(page: Page, id: string): Promise<string> {
	const task = (await (await page.request.get(`${server.baseURL}/api/tasks/${id}`)).json()) as {
		lifecycleState: string;
	};
	return task.lifecycleState;
}

/**
 * Open the popover and keep it open. A new operation opens it by itself for 4 s and then closes it
 * again, so a plain click could close it instead: hover first (that is an interaction and ends the
 * automatic close), then click only when it is not open.
 */
async function openTray(page: Page) {
	const indicator = page.getByTestId("activity-indicator");
	await expect(indicator).toBeVisible();
	await indicator.hover();
	if ((await indicator.getAttribute("aria-expanded")) !== "true") await indicator.click();
	await expect(indicator).toHaveAttribute("aria-expanded", "true");
	return page.getByTestId("activity-tray");
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
		// The stack's one timer takes a finished row away (about 4 s), without any request; when the
		// stack is empty the indicator goes too.
		await expect(page.getByTestId("activity-indicator")).toBeHidden({ timeout: 10_000 });
		// Hidden in this tab only: the server still lists it until its own expiry.
		expect((await operations(page)).some((o) => o.state === "done")).toBe(true);
	});

	test("the indicator sits in the header next to the bell; nothing floats over page content at 1280 and 1440", async ({ page }) => {
		const open = createTask("Layout still open", "--status in-progress");
		const done = createTask("Layout finishable", "--status done");
		await page.goto(`${server.baseURL}/tasks`);
		await expect(page.getByTestId("activity-indicator")).toBeHidden(); // nothing running: no indicator
		await startBatch(page, [done, open]);
		const indicator = page.getByTestId("activity-indicator");
		await expect(indicator).toBeVisible();
		await expect(indicator).toHaveAccessibleName("1 background operation, 1 failed");

		// A toast at the same time: creating a Task from the UI shows "Task created".
		await page.getByRole("button", { name: /new task/i }).first().click();
		await page.getByPlaceholder(/title/i).first().fill("Toast Task");
		await page.getByRole("button", { name: /create task/i }).click();
		const toast = page.locator("ol[aria-live=polite] li").first();
		await expect(toast).toBeVisible();
		const toastBox = await toast.boundingBox();
		if (!toastBox) throw new Error("no toast box");

		for (const width of [1280, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			for (const path of ["/tasks", "/kanban", "/graph", "/runtime"]) {
				await page.goto(`${server.baseURL}${path}`);
				await expect(indicator).toBeVisible();
				// Closed (a reload never opens it): in the header, next to the bell, apart from the toast...
				await expect(indicator).toHaveAttribute("aria-expanded", "false");
				const header = await page.locator("header").first().boundingBox();
				const box = await indicator.boundingBox();
				const bell = await page.getByRole("button", { name: /^Notifications/ }).first().boundingBox();
				if (!header || !box || !bell) throw new Error("layout boxes missing");
				expect(box.y).toBeGreaterThanOrEqual(header.y);
				expect(box.y + box.height).toBeLessThanOrEqual(header.y + header.height + 1);
				expect(box.x + box.width).toBeLessThanOrEqual(bell.x + 1); // left of the bell, not over it
				expect(bell.x - (box.x + box.width)).toBeLessThan(40); // and next to it
				// ...and nothing in the page is under it: every control of the page answers its own click.
				const covered = await page.evaluate(() => {
					const root = document.querySelector('[data-testid="activity-tray-root"]');
					const hit: string[] = [];
					for (const el of Array.from(document.querySelectorAll<HTMLElement>("main button, main a[href], main input, main select, main textarea, main [role=button], main [role=tab]"))) {
						if (root?.contains(el)) continue;
						const r = el.getBoundingClientRect();
						if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight) continue;
						const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
						if (top && root?.contains(top)) hit.push(el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 30) || el.tagName);
					}
					return hit;
				});
				expect(covered, `${width} ${path}`).toEqual([]);
			}
		}
	});

	test("the indicator toggles the popover; Escape closes it and returns focus; an outside click closes it", async ({ page }) => {
		const open = createTask("Toggle open", "--status in-progress");
		const done = createTask("Toggle done", "--status done");
		await page.goto(`${server.baseURL}/tasks`);
		await startBatch(page, [done, open]);
		const tray = await openTray(page);
		const indicator = page.getByTestId("activity-indicator");
		await expect(tray).toBeVisible();
		await indicator.click();
		await expect(indicator).toHaveAttribute("aria-expanded", "false");
		await expect(tray).toHaveAttribute("data-open", "false");
		await indicator.click();
		await expect(tray).toHaveAttribute("data-open", "true");
		await page.keyboard.press("Escape");
		await expect(indicator).toHaveAttribute("aria-expanded", "false");
		await expect(indicator).toBeFocused();
		await indicator.click();
		await expect(tray).toBeVisible();
		await page.getByRole("heading", { name: "Tasks" }).click();
		await expect(indicator).toHaveAttribute("aria-expanded", "false");
	});

	test("it opens by itself for about 4 s when an operation starts or fails, and stays if the person is on it", async ({ page }) => {
		const open = createTask("Auto open", "--status in-progress");
		const done = createTask("Auto done", "--status done");
		// The snapshot is taken on the stream's `connected`, so once it is answered events reach the page.
		const live = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/operations");
		await page.goto(`${server.baseURL}/tasks`);
		await live;
		// The header (and the tray in it) mounts once the config is loaded; give it a beat after that.
		await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
		await page.waitForTimeout(500);
		const indicator = page.getByTestId("activity-indicator");
		await startBatch(page, [done, open]);
		await expect(indicator).toHaveAttribute("aria-expanded", "true");
		// Not touched: it closes again by itself, and the failed row stays in the stack.
		await expect(indicator).toHaveAttribute("aria-expanded", "false", { timeout: 9000 });
		await expect(indicator).toBeVisible();

		// Touched: the pointer on the popover keeps it open past the 4 s.
		const open2 = createTask("Auto open 2", "--status in-progress");
		const done2 = createTask("Auto done 2", "--status done");
		await startBatch(page, [done2, open2]);
		await expect(indicator).toHaveAttribute("aria-expanded", "true");
		await page.getByTestId("activity-tray").hover();
		await page.waitForTimeout(5500);
		await expect(indicator).toHaveAttribute("aria-expanded", "true");
	});

	test("a reload with a failed row does not open the popover (a snapshot is not an event)", async ({ page }) => {
		const open = createTask("Reload quiet open", "--status in-progress");
		const done = createTask("Reload quiet done", "--status done");
		await page.goto(`${server.baseURL}/tasks`);
		await startBatch(page, [done, open]);
		await expect(page.getByTestId("activity-indicator")).toBeVisible();
		await page.reload();
		const indicator = page.getByTestId("activity-indicator");
		await expect(indicator).toBeVisible();
		await page.waitForTimeout(1500);
		await expect(indicator).toHaveAttribute("aria-expanded", "false");
	});

	test("with the popover closed a failure is still announced (the live region stays mounted)", async ({ page }) => {
		const open = createTask("Announce open", "--status in-progress");
		const done = createTask("Announce done", "--status done");
		const live = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/operations");
		await page.goto(`${server.baseURL}/tasks`);
		await live;
		await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
		await page.waitForTimeout(500);
		await startBatch(page, [done, open]);
		const indicator = page.getByTestId("activity-indicator");
		const tray = page.getByTestId("activity-tray");
		await expect(tray.getByRole("alert")).toHaveText(/Archiving 2 tasks: Failed/);
		// Close it: the list leaves the accessibility tree, but the live region stays and still holds the words.
		await page.keyboard.press("Escape");
		await expect(indicator).toHaveAttribute("aria-expanded", "false");
		await expect(tray.getByRole("list")).toHaveCount(0);
		await expect(tray.getByRole("alert")).toHaveText(/Archiving 2 tasks: Failed/);
		await expect(tray.getByRole("status").first()).toBeAttached();
	});

	test("with reduced motion it still opens by itself and closes after about 4 s, only without any transition", async ({ page }) => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		const open = createTask("RM auto open", "--status in-progress");
		const done = createTask("RM auto done", "--status done");
		const live = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/operations");
		await page.goto(`${server.baseURL}/tasks`);
		await live;
		await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
		await page.waitForTimeout(500);
		await startBatch(page, [done, open]);
		const indicator = page.getByTestId("activity-indicator");
		await expect(indicator).toHaveAttribute("aria-expanded", "true");
		const tray = page.getByTestId("activity-tray");
		// The global reduced-motion block makes it 1e-5 s: instant.
		const durations = await tray.evaluate((el) => getComputedStyle(el).transitionDuration.split(",").map((x) => Number.parseFloat(x)));
		expect(durations.every((d) => d < 0.001)).toBe(true);
		await expect(indicator).toHaveAttribute("aria-expanded", "false", { timeout: 9000 });
	});

	test("an open failed row shows its whole reason wrapped, and the collapsed line carries it as a title", async ({ page }) => {
		const open = createTask("Reason open", "--status in-progress");
		const done = createTask("Reason done", "--status done");
		await page.goto(`${server.baseURL}/tasks`);
		await startBatch(page, [done, open]);
		await expect(page.getByTestId("activity-tray")).toContainText("not changed");
		const tray = await openTray(page);
		await expect(tray.locator("[title*='not changed']").first()).toHaveAttribute("title", /must be done/);
		await tray.getByText("Archiving 2 tasks").click();
		const reason = tray.locator("p", { hasText: "not changed" });
		await expect(reason).toBeVisible();
		await expect(reason).toContainText(/must be done/);
		// wrapped, not cut: the paragraph shows all of its text
		expect(await reason.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && getComputedStyle(el).textOverflow !== "ellipsis")).toBe(true);
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
		const ids = await doneTasks(page, 600, "Cancel");
		await page.goto(`${server.baseURL}/tasks`);
		const id = await startBatch(page, ids);
		await expect(page.getByTestId("activity-tray")).toContainText("Archiving 600 tasks");
		const tray = await openTray(page);
		await tray.getByText("Archiving 600 tasks").click();
		await tray.getByRole("button", { name: "Cancel" }).click();

		await expect.poll(async () => (await operations(page)).find((o) => o.id === id)?.state, { timeout: 30_000 }).toBe("cancelled");
		const op = (await operations(page)).find((o) => o.id === id) as Op;
		const m = /^(\d+) archived, (\d+) left/.exec(op.message ?? "");
		expect(m).not.toBeNull();
		const archived = Number(m?.[1]);
		const left = Number(m?.[2]);
		expect(archived + left).toBe(600);
		expect(left).toBeGreaterThan(0);
		await expect(tray).toContainText(`${archived} archived, ${left} left`);

		// Exactly the processed ones are archived; the untouched ones are still done.
		const states = await statesOf(page, ids);
		expect(states.filter((s) => s === "archived")).toHaveLength(archived);
		expect(states.filter((s) => s === "done")).toHaveLength(left);

		// A cancelled row with work left is not aged out by the timer.
		await page.waitForTimeout(5500);
		await expect(page.getByTestId("activity-indicator")).toBeVisible();
		await expect(tray).toContainText("left");

		// Run again takes only what is left, and finishes.
		await tray.getByText(/Archiving 600 tasks/).first().click();
		await tray.getByRole("button", { name: "Run again" }).click();
		await expect.poll(async () => {
			const all = await statesOf(page, ids);
			return all.filter((s) => s === "archived").length;
		}, { timeout: 90_000 }).toBe(600);
		const again = (await operations(page)).find((o) => o.id !== id && o.state === "done");
		expect(again?.progress?.total).toBe(left);
	});

	test("the elapsed clock of a running operation ticks (it is not stuck at 0:00)", async ({ page }) => {
		const ids = await doneTasks(page, 600, "Clock");
		await page.goto(`${server.baseURL}/tasks`);
		const id = await startBatch(page, ids);
		await expect(page.getByTestId("activity-tray")).toContainText("Archiving 600 tasks");
		const tray = await openTray(page);
		await tray.getByText("Archiving 600 tasks").click();
		// More than two seconds in, while it still runs: the clock must have moved off 0:00.
		await expect.poll(async () => (await operations(page)).find((o) => o.id === id)?.state).toBe("running");
		await page.waitForTimeout(2500);
		const state = (await operations(page)).find((o) => o.id === id)?.state;
		test.skip(state !== "running", "the batch finished before the clock could be sampled on this machine");
		await expect(tray).toContainText(/0:0[2-9]|0:[1-5]\d|[1-9]:\d\d/);
	});

	test("Cancel reads Cancelling (not Running) before the final 'N archived, M left'", async ({ page }) => {
		const ids = await doneTasks(page, 600, "Cancelling");
		await page.goto(`${server.baseURL}/tasks`);
		// Record every text the tray shows, so a short state is not missed by polling.
		await page.evaluate(() => {
			const w = window as unknown as { __tray: string[] };
			w.__tray = [];
			new MutationObserver(() => {
				const el = document.querySelector('[data-testid="activity-tray"]');
				const text = el?.textContent ?? "";
				if (text && w.__tray[w.__tray.length - 1] !== text) w.__tray.push(text);
			}).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
		});
		await startBatch(page, ids);
		await expect(page.getByTestId("activity-tray")).toContainText("Archiving 600 tasks");
		const tray = await openTray(page);
		await tray.getByText("Archiving 600 tasks").click();
		await tray.getByRole("button", { name: "Cancel" }).click();
		await expect(tray).toContainText(/\d+ archived, \d+ left/, { timeout: 30_000 });
		const texts = await page.evaluate(() => (window as unknown as { __tray: string[] }).__tray);
		const firstCancelling = texts.findIndex((x) => x.includes("Cancelling"));
		const final = texts.findIndex((x) => /\d+ archived, \d+ left/.test(x));
		expect(firstCancelling).toBeGreaterThanOrEqual(0);
		expect(firstCancelling).toBeLessThan(final);
		// and no frame between the click and the end still claims "Running" with Cancelling shown
		for (const x of texts.slice(firstCancelling, final)) expect(x).not.toContain("Running");
	});

	test("a partly failed batch stays with its reasons, a Runtime link and Run again; Dismiss removes it on the server", async ({ page }) => {
		const open = createTask("Tray still open", "--status in-progress");
		const done = createTask("Tray finishable", "--status done");
		await page.goto(`${server.baseURL}/tasks`);
		const id = await startBatch(page, [done, open]);

		await expect(page.getByTestId("activity-tray")).toContainText("Archiving 2 tasks");
		const tray = await openTray(page);
		// The reason is on the collapsed line already (before the card is opened).
		await expect(tray).toContainText("1 archived, 1 not changed");
		await expect(tray).toContainText(`#${open}`);
		const link = tray.getByRole("link", { name: "Open Runtime" });
		await expect(link).toHaveAttribute("href", "/runtime");
		await tray.getByText("Archiving 2 tasks").click();
		await expect(tray.getByRole("button", { name: "Run again" })).toBeVisible();
		// A failed row does not age out.
		await page.waitForTimeout(5000);
		await expect(page.getByTestId("activity-indicator")).toBeVisible();
		await expect(tray).toBeVisible();

		await link.click();
		await expect(page).toHaveURL(/\/runtime$/);

		await tray.getByRole("button", { name: "Dismiss" }).click();
		await expect(page.getByTestId("activity-indicator")).toBeHidden();
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
		await expect(page.getByTestId("activity-tray")).toContainText("not changed");
		const tray = await openTray(page);
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
