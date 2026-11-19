import { expect, test } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;
test.beforeEach(async () => {
	server = await startServer();
});
test.afterEach(() => server?.cleanup());

test.describe("Server update notice (KN-ZV8WGG)", () => {
	test("the real server reports its version", async ({ page }) => {
		const res = await page.request.get(`${server.baseURL}/api/version`);
		expect(res.status()).toBe(200);
		expect(((await res.json()) as { version: string }).version).toMatch(/^\d+\.\d+\.\d+/);
	});

	test("a reconnect to a server of another version shows 'Knowns was updated' with Reload; the same version shows nothing", async ({ page }) => {
		// The event stream ends after each `connected` and the browser reconnects; each connect makes the
		// page ask the version, and the third answer is a newer server.
		const versions = ["0.36.1", "0.36.1", "0.36.2"];
		let connects = 0;
		let asked = 0;
		await page.route("**/api/events*", async (route) => {
			connects++;
			await route.fulfill({
				status: 200,
				headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
				body: `retry: 300\nevent: connected\ndata: {"timestamp":${Date.now()}}\n\n`,
			});
		});
		await page.route("**/api/version", async (route) => {
			const version = versions[Math.min(asked++, versions.length - 1)];
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version }) });
		});
		await page.goto(server.baseURL);
		const notice = page.getByTestId("server-update-notice");
		// two connections with the same version: nothing to say
		await expect.poll(() => asked, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
		void connects;
		await expect(notice).toHaveCount(0);
		// the third reports 0.36.2
		await expect(notice).toBeVisible({ timeout: 10_000 });
		await expect(notice).toContainText("Knowns was updated to v0.36.2");
		await expect(notice.getByRole("button", { name: "Reload" })).toBeVisible();
		// non-blocking: the page underneath still works
		await expect(page.getByRole("heading").first()).toBeVisible();
		const reload = page.waitForEvent("framenavigated");
		await notice.getByRole("button", { name: "Reload" }).click();
		await reload;
	});
});
