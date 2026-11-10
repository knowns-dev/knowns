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
		await page.getByRole("tab", { name: "Analytics" }).click();

		const aging = page.getByRole("region", { name: "Where does work get stuck?" });
		await expect(aging.getByRole("img", { name: /Open tasks by status and days since last update/ })).toBeVisible();
		await expect(aging.getByRole("rowheader", { name: "On Hold", exact: true })).toBeAttached();
		await expect(aging.getByText("All 3 open tasks moved in the last week. Nothing looks stuck.")).toBeVisible();
		await expect(aging.getByText(/Knowns does not record when work started/)).toBeVisible();
	});

	test("shows a continuable focus and ranked attention queue", async ({ page }) => {
		await page.goto(server.baseURL);

		const focus = page.getByRole("region", { name: "Continue working" }).getByRole("link", { name: /Dashboard Current Focus/ });
		await expect(focus).toBeVisible();
		const attention = page.getByRole("region", { name: "Needs your attention" }).getByRole("link", { name: /Dashboard High Priority/ });
		await expect(attention).toBeVisible();
		await expect(attention.getByText("high priority", { exact: true })).toBeVisible();

		await focus.click();
		await expect(page).toHaveURL(/\/tasks\/[a-z0-9.-]+$/i);
	});

	test("switches throughput periods", async ({ page }) => {
		await page.goto(server.baseURL);
		const progress = page.getByRole("region", { name: "Progress" });

		await progress.getByRole("button", { name: "7d" }).click();
		await expect(progress.getByRole("button", { name: "7d" })).toHaveAttribute("aria-pressed", "true");
		await expect(progress.getByRole("img", { name: /last 7 days\. bar chart, 7 points/ })).toBeVisible();

		await progress.getByRole("button", { name: "90d" }).click();
		await expect(progress.getByRole("button", { name: "90d" })).toHaveAttribute("aria-pressed", "true");
		await expect(progress.getByRole("img", { name: /last 90 days\. bar chart, 13 points/ })).toBeVisible();

		// The Analytics tab shares the range.
		await page.getByRole("tab", { name: "Analytics" }).click();
		await expect(page.getByRole("radio", { name: "90 days" })).toBeChecked();
	});

	test("keeps available knowledge signals visible when one source fails", async ({ page }) => {
		await page.route("**/api/validate/sdd", async (route) => {
			await route.fulfill({ status: 503, body: "unavailable" });
		});
		await page.goto(server.baseURL);

		await expect(page.getByText("Partial data", { exact: true })).toBeVisible({ timeout: 10_000 });
		await page.getByRole("tab", { name: "Analytics" }).click();
		const knowledge = page.getByRole("region", { name: "Is knowledge keeping up with the work?" });
		await expect(knowledge.getByText(/Could not load Spec coverage\. The other numbers are current\./)).toBeVisible();
		await expect(knowledge.getByText("Spec coverage is unavailable")).toBeVisible();
		await expect(knowledge.getByText("Memories confirmed")).toBeVisible();
		await expect(knowledge.getByText("Decisions settled")).toBeVisible();
	});

	test("stacks the side widgets after the main ones on a narrow viewport", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(server.baseURL);

		const mainBox = await page.getByRole("heading", { name: "Needs your attention" }).boundingBox();
		const sideBox = await page.getByRole("heading", { name: "Waiting for you" }).boundingBox();
		expect(mainBox).not.toBeNull();
		expect(sideBox).not.toBeNull();
		expect(mainBox!.y).toBeLessThan(sideBox!.y);
	});

	test("puts the side widgets in a column beside the main ones on desktop", async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto(server.baseURL);

		const mainBox = await page.getByRole("heading", { name: "Continue working" }).boundingBox();
		const sideBox = await page.getByRole("heading", { name: "Waiting for you" }).boundingBox();
		expect(mainBox).not.toBeNull();
		expect(sideBox).not.toBeNull();
		expect(mainBox!.x).toBeLessThan(sideBox!.x);
		expect(Math.abs(mainBox!.y - sideBox!.y)).toBeLessThan(40);
	});
});
