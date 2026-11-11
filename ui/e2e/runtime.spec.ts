import { test, expect, type Page } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

const ROOT = "/work/acme/.knowns";
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const minutesAhead = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

// A runtime with something in every state: a failing LSP, a running one, a
// dead-lettered reconcile backlog, a running index job and one client.
const SERVICES = {
	services: [
		{
			name: "gopls",
			type: "lsp",
			status: "running",
			pid: 4242,
			uptime: "2h",
			enabledInConfig: true,
			details: { detected: "true", backend: "gopls", language: "go" },
		},
		{
			name: "pyright",
			type: "lsp",
			status: "error",
			enabledInConfig: true,
			details: {
				detected: "true",
				install_state: "not_installed",
				reason: "not_installed",
				install_cmd: "npm i -g pyright",
			},
		},
		{ name: "cloudflared", type: "cloudflared", status: "disabled", enabledInConfig: false },
	],
};

const PS = {
	status: {
		running: true,
		pid: 777,
		version: "9.9.9",
		startedAt: minutesAgo(90),
		clients: [{ clientKind: "mcp", projectRoot: ROOT, pid: 31337, updatedAt: minutesAgo(0) }],
		projects: [{ projectRoot: ROOT, queuedJobs: 2, runningJobs: 1 }],
	},
	projects: [
		{
			root: ROOT,
			running: [
				{
					id: "run-1",
					key: "index",
					kind: "index",
					target: "docs",
					requestedAt: minutesAgo(1),
					runAfter: minutesAgo(1),
					phase: "embedding",
					processed: 40,
					total: 80,
				},
			],
			queued: [
				{
					id: "dead-1",
					key: "qdrant",
					kind: "qdrant",
					target: "chunk-a",
					requestedAt: minutesAgo(200),
					runAfter: minutesAhead(60 * 23),
					attempts: 5,
					lastError: "connection refused",
					deadLetter: true,
				},
				{
					id: "dead-2",
					key: "qdrant",
					kind: "qdrant",
					target: "chunk-b",
					requestedAt: minutesAgo(200),
					runAfter: minutesAhead(60 * 23),
					attempts: 5,
					lastError: "connection refused",
					deadLetter: true,
				},
			],
			recent: [
				{
					jobId: "done-1",
					key: "index",
					kind: "index",
					target: "tasks",
					success: true,
					requestedAt: minutesAgo(10),
					startedAt: minutesAgo(10),
					completedAt: minutesAgo(9),
					attemptCount: 1,
					details: { phase: "done", stats: { chunks: 120 } },
				},
			],
		},
	],
};

async function mockRuntime(page: Page) {
	const retries: unknown[] = [];
	await page.route("**/api/runtime/services", (route) => route.fulfill({ json: SERVICES }));
	await page.route("**/api/runtime/ps", (route) => route.fulfill({ json: PS }));
	await page.route("**/api/runtime/retry", async (route) => {
		retries.push(route.request().postDataJSON());
		await route.fulfill({ json: { results: [{ projectRoot: ROOT, released: 2 }] } });
	});
	return retries;
}

test.describe("Runtime page", () => {
	test("loads live status from the real daemon", async ({ page }) => {
		await page.goto(`${server.baseURL}/runtime`);
		await expect(page.getByRole("heading", { name: "Runtime", level: 1 })).toBeVisible();
		await expect(page.getByTestId("runtime-tile-daemon")).toBeVisible();
		await expect(page.getByRole("tab", { name: /Services/ })).toHaveAttribute("aria-selected", "true");
		await expect(page.getByTestId("runtime-service-fleet")).toBeVisible();
	});

	test("shows what is running and what needs attention", async ({ page }) => {
		await mockRuntime(page);
		await page.goto(`${server.baseURL}/runtime`);

		await expect(page.getByTestId("runtime-tile-daemon")).toContainText("Online");
		await expect(page.getByTestId("runtime-tile-daemon")).toContainText("v9.9.9");
		await expect(page.getByTestId("runtime-operational-posture")).toContainText("Action required");

		// Attention and running groups are open; disabled stays folded.
		const fleet = page.getByTestId("runtime-service-fleet");
		await expect(fleet.locator('[data-service-state="attention"]')).toContainText("pyright");
		await expect(fleet.locator('[data-service-state="attention"]')).toContainText("npm i -g pyright");
		await expect(fleet.locator('[data-service-state="running"]')).toContainText("PID 4242");
		await expect(fleet.getByTitle("cloudflared")).toHaveCount(0);
		await fleet.getByRole("button", { name: /Disabled/ }).click();
		await expect(fleet.getByTitle("cloudflared")).toBeVisible();

		// The banner narrows the list to what needs action.
		await page.getByTestId("runtime-operational-posture").getByRole("button", { name: "Show 1 service" }).click();
		await expect(page.getByRole("radio", { name: /Attention/ })).toHaveAttribute("aria-checked", "true");
		await expect(fleet.locator("[data-service-state]")).toHaveCount(1);

		await expect(fleet.getByRole("link", { name: "Configure pyright" })).toHaveAttribute("href", /\/config\?category=code/);
	});

	test("groups failures by cause and retries them", async ({ page }) => {
		const retries = await mockRuntime(page);
		await page.goto(`${server.baseURL}/runtime`);
		await page.getByRole("tab", { name: /Activity/ }).click();

		const activity = page.getByTestId("runtime-activity");
		await expect(activity).toContainText("2 jobs failed permanently across 1 project");
		await expect(page.getByTestId("runtime-failure-cause")).toHaveCount(1);
		await expect(page.getByTestId("runtime-work-queue")).toContainText("docs");

		const cause = page.getByTestId("runtime-failure-cause");
		await cause.getByRole("button", { expanded: false }).click();
		await expect(cause.getByText("chunk-a")).toBeVisible();

		await cause.getByRole("button", { name: /^Retry 2 qdrant jobs/ }).click();
		await expect.poll(() => retries.length).toBe(1);
		expect(retries[0]).toEqual({
			scope: "jobs",
			jobs: [
				{ projectRoot: ROOT, jobId: "dead-1" },
				{ projectRoot: ROOT, jobId: "dead-2" },
			],
		});

		await activity.getByRole("button", { name: "Retry all" }).click();
		await expect.poll(() => retries.length).toBe(2);
		expect(retries[1]).toEqual({ scope: "all" });

		await activity.getByRole("button", { name: /Recent completions/ }).click();
		await expect(activity.getByText("tasks", { exact: true })).toBeVisible();
	});

	test("lists attached clients and shows an empty state", async ({ page }) => {
		await mockRuntime(page);
		await page.goto(`${server.baseURL}/runtime`);
		await page.getByTestId("runtime-tile-clients").click();
		await expect(page.getByTestId("runtime-clients")).toContainText("mcp");
		await expect(page.getByTestId("runtime-clients")).toContainText("/work/acme");

		await page.unroute("**/api/runtime/ps");
		await page.route("**/api/runtime/ps", (route) =>
			route.fulfill({ json: { ...PS, status: { ...PS.status, clients: [] } } }),
		);
		await page.getByRole("button", { name: "Refresh runtime status" }).click();
		await expect(page.getByTestId("runtime-clients")).toContainText("No clients attached");
	});

	test("a stopped daemon is idle until work waits for it", async ({ page }) => {
		const stopped = { ...PS.status, running: false, pid: undefined, clients: [] };
		const idle = { status: stopped, projects: [{ root: ROOT, running: [], queued: [], recent: [] }] };
		await page.route("**/api/runtime/services", (route) => route.fulfill({ json: { services: [] } }));
		await page.route("**/api/runtime/ps", (route) => route.fulfill({ json: idle }));
		await page.goto(`${server.baseURL}/runtime`);
		await expect(page.getByTestId("runtime-tile-daemon")).toContainText("Idle");
		await expect(page.getByTestId("runtime-tile-daemon")).toContainText("starts on demand");
		await expect(page.getByTestId("runtime-operational-posture")).toHaveCount(0);
		await expect(page.getByTestId("runtime-service-fleet")).toContainText("No managed services reported");

		const waiting = {
			status: stopped,
			projects: [
				{
					root: ROOT,
					running: [],
					queued: [{ id: "q-1", key: "index", kind: "index", target: "docs", requestedAt: minutesAgo(5), runAfter: minutesAgo(5) }],
					recent: [],
				},
			],
		};
		await page.unroute("**/api/runtime/ps");
		await page.route("**/api/runtime/ps", (route) => route.fulfill({ json: waiting }));
		await page.getByRole("button", { name: "Refresh runtime status" }).click();
		await expect(page.getByTestId("runtime-operational-posture")).toContainText("Runtime daemon is offline");
		await expect(page.getByTestId("runtime-tile-daemon")).toContainText("Offline");
	});

	test("shows a page error when nothing can be read", async ({ page }) => {
		await page.route("**/api/runtime/services", (route) => route.fulfill({ status: 500, body: "down" }));
		await page.route("**/api/runtime/ps", (route) => route.fulfill({ status: 500, body: "down" }));
		await page.goto(`${server.baseURL}/runtime`);
		await expect(page.getByRole("alert").filter({ hasText: "Runtime status could not load" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
	});

	test("fits a phone screen", async ({ page }) => {
		await mockRuntime(page);
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto(`${server.baseURL}/runtime`);
		await expect(page.getByTestId("runtime-tile-daemon")).toBeVisible();
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
		expect(overflow).toBeLessThanOrEqual(0);
	});
});
