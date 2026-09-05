import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
	server.cli('task create "Dashboard High Priority" -d "Needs attention" --priority high -l "ui"');
	const progressOutput = server.cli('task create "Dashboard Current Focus" -d "Current focus" --priority medium -l "ui"');
	const progressId = progressOutput.match(/Created task\s+([a-z0-9.-]+)/i)?.[1];
	if (progressId) server.cli(`task edit ${progressId} -s in-progress`);
	const holdOutput = server.cli('task create "Dashboard On Hold" -d "Custom status coverage" --priority low -l "ops"');
	const holdId = holdOutput.match(/Created task\s+([a-z0-9.-]+)/i)?.[1];
	if (holdId) server.cli(`task edit ${holdId} -s on-hold`);
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Dashboard Extended", () => {
	test("uses configured and actual statuses in work aging", async ({ page }) => {
		await page.goto(server.baseURL);

		await expect(page.getByText("On Hold", { exact: true }).first()).toBeVisible();
		await expect(page.getByText("Update-age proxy")).toBeVisible();
	});

	test("shows a continuable focus and ranked attention queue", async ({ page }) => {
		await page.goto(server.baseURL);

		await expect(page.getByText("Dashboard Current Focus")).toBeVisible();
		await expect(page.getByRole("link", { name: /Continue task/ })).toBeVisible();
		await expect(page.getByText("Dashboard High Priority")).toBeVisible();
		await expect(page.getByText("high priority", { exact: true })).toBeVisible();
	});

	test("switches throughput periods", async ({ page }) => {
		await page.goto(server.baseURL);

		await page.getByRole("button", { name: "7d" }).click();
		await expect(page.getByRole("button", { name: "7d" })).toHaveAttribute("aria-pressed", "true");
		await expect(page.getByText("7 buckets")).toBeVisible();

		await page.getByRole("button", { name: "90d" }).click();
		await expect(page.getByRole("button", { name: "90d" })).toHaveAttribute("aria-pressed", "true");
		await expect(page.getByText("13 buckets")).toBeVisible();
	});

	test("keeps available knowledge signals visible when one source fails", async ({ page }) => {
		await page.route("**/api/validate/sdd", async (route) => {
			await route.fulfill({ status: 503, body: "unavailable" });
		});
		await page.goto(server.baseURL);

		await expect(page.getByText(/Partial data/)).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText(/Unavailable now: Spec coverage/)).toBeVisible();
		await expect(page.getByText("Document inventory")).toBeVisible();
	});

	test("places project pulse before analytics on a narrow viewport", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(server.baseURL);

		const pulseBox = await page.getByRole("heading", { name: "Project pulse" }).boundingBox();
		const throughputBox = await page.getByRole("heading", { name: "Throughput" }).boundingBox();
		expect(pulseBox).not.toBeNull();
		expect(throughputBox).not.toBeNull();
		expect(pulseBox!.y).toBeLessThan(throughputBox!.y);
	});

	test("keeps desktop analysis first and project pulse sticky-ready", async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto(server.baseURL);

		const throughputBox = await page.getByRole("heading", { name: "Throughput" }).boundingBox();
		const pulseBox = await page.getByRole("heading", { name: "Project pulse" }).boundingBox();
		expect(throughputBox).not.toBeNull();
		expect(pulseBox).not.toBeNull();
		expect(throughputBox!.x).toBeLessThan(pulseBox!.x);
	});
});
