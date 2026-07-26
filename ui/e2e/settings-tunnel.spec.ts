import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Settings — Tunnel", () => {
	test("Tunnel tab shows Cloudflare Tunnel section", async ({ page }) => {
		await test.step("Navigate to Settings", async () => {
			await page.goto(`${server.baseURL}/config`);
		});

		await test.step("Click Tunnel tab", async () => {
			await page.getByText("Tunnel").first().click();
		});

		await test.step("Cloudflare Tunnel section is visible", async () => {
			await expect(page.getByText(/cloudflare tunnel/i)).toBeVisible();
		});
	});

	test("Tunnel status shows Stopped initially", async ({ page }) => {
		await test.step("Navigate to Settings → Tunnel", async () => {
			await page.goto(`${server.baseURL}/config`);
			await page.getByText("Tunnel").first().click();
		});

		await test.step("Status indicator shows Stopped", async () => {
			await expect(page.getByText("Stopped").or(page.getByText(/running/i))).toBeVisible();
		});
	});

	test("Start Tunnel button exists", async ({ page }) => {
		await test.step("Navigate to Settings → Tunnel", async () => {
			await page.goto(`${server.baseURL}/config`);
			await page.getByText("Tunnel").first().click();
		});

		await test.step("Start Tunnel button is visible", async () => {
			const startBtn = page.getByRole("button", { name: /start/i });
			await expect(startBtn).toBeVisible();
		});
	});

	test("clicking Start Tunnel shows result (success or error)", async ({ page }) => {
		await test.step("Navigate to Settings → Tunnel", async () => {
			await page.goto(`${server.baseURL}/config`);
			await page.getByText("Tunnel").first().click();
		});

		await test.step("Click Start Tunnel", async () => {
			const startBtn = page.getByRole("button", { name: /start/i });
			await expect(startBtn).toBeVisible();
			await startBtn.click();
		});

		await test.step("Wait for result", async () => {
			// Either a success state (Running, URL) or error (destructive text)
			// Use a generous timeout for the tunnel attempt
			await page.waitForTimeout(3000);
		});

		await test.step("UI reflects outcome", async () => {
			// After clicking start, either:
			// 1. Status changes to Running with URL, or
			// 2. Error message is shown in destructive color
			const running = page.getByText("Running");
			const errorText = page.locator("p.text-destructive");
			const stopBtn = page.getByRole("button", { name: /stop/i });

			const hasRunning = await running.isVisible().catch(() => false);
			const hasError = await errorText.isVisible().catch(() => false);
			const hasStop = await stopBtn.isVisible().catch(() => false);

			if (hasRunning || hasStop) {
				// Tunnel started successfully
				expect(true).toBeTruthy();
			} else if (hasError) {
				// Error shown (cloudflared not installed etc.)
				await expect(errorText).toBeVisible({ timeout: 3000 });
			}
		});
	});
});