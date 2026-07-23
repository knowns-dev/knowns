import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Settings — Security (set from UI)", () => {
	test("Security tab shows Unprotected status initially", async ({ page }) => {
		await test.step("Navigate to Settings", async () => {
			await page.goto(`${server.baseURL}/config`);
		});

		await test.step("Click Security tab", async () => {
			await page.getByText("Security").first().click();
		});

		await test.step("Unprotected status is shown", async () => {
			await expect(page.getByText("Unprotected")).toBeVisible();
		});
	});

	test("Password Protection section is visible", async ({ page }) => {
		await test.step("Navigate to Settings → Security", async () => {
			await page.goto(`${server.baseURL}/config`);
			await page.getByText("Security").first().click();
		});

		await test.step("Password Protection header is visible", async () => {
			await expect(page.getByText(/password protection/i)).toBeVisible();
		});
	});

	test("password input and Set button are visible when unprotected", async ({ page }) => {
		await test.step("Navigate to Settings → Security", async () => {
			await page.goto(`${server.baseURL}/config`);
			await page.getByText("Security").first().click();
		});

		await test.step("Password input is visible", async () => {
			const pwInput = page.locator('input[placeholder="Enter password"]');
			await expect(pwInput).toBeVisible();
		});

		await test.step("Set button is visible", async () => {
			await expect(page.getByRole("button", { name: /set/i })).toBeVisible();
		});
	});

	test("setting a password changes status to Protected", async ({ page }) => {
		await test.step("Navigate to Settings → Security", async () => {
			await page.goto(`${server.baseURL}/config`);
			await page.getByText("Security").first().click();
		});

		await test.step("Enter password and click Set", async () => {
			const pwInput = page.locator('input[placeholder="Enter password"]');
			await expect(pwInput).toBeVisible();
			await pwInput.fill("mytestpassword");
			await page.waitForTimeout(500);

			// Listen for API response
			const responsePromise = page.waitForResponse(
				(resp) => resp.url().includes("/api/auth/password") && resp.request().method() === "POST",
				{ timeout: 10000 }
			).catch(() => null);

			// Verify button is enabled (not disabled)
			const setBtn = page.locator('button:has-text("Set")').first();
			await expect(setBtn).toBeEnabled({ timeout: 3000 });
			await setBtn.click();

			// Wait for API response
			const resp = await responsePromise;
			if (resp) {
				const status = resp.status();
				if (status !== 200) {
					const body = await resp.text().catch(() => "");
					throw new Error(`Set password API returned ${status}: ${body}`);
				}
			} else {
				throw new Error("No API response received for POST /api/auth/password");
			}

			await page.waitForTimeout(1000);
		});

		await test.step("Status changes to Protected", async () => {
			await expect(page.getByText("Protected").first()).toBeVisible({ timeout: 10000 });
		});

		await test.step("Remove Password button appears", async () => {
			await expect(page.getByText(/remove password/i).first()).toBeVisible();
		});
	});

	test("removing password changes status back to Unprotected", async ({ page }) => {
		await test.step("Set password via API first", async () => {
			// Ensure password is set so we can test removal
			const setResp = await page.request.post(`${server.baseURL}/api/auth/password`, {
				data: { password: "removetest123" },
			});
			// May fail if already set — that's OK
			if (!setResp.ok()) {
				// Already protected — login first
				const loginResp = await page.request.post(`${server.baseURL}/api/auth/login`, {
					data: { password: "mytestpassword" },
				});
				if (!loginResp.ok()) {
					// Try the other password
					await page.request.post(`${server.baseURL}/api/auth/login`, {
						data: { password: "removetest123" },
					});
				}
			}
		});

		await test.step("Navigate to Settings → Security", async () => {
			await page.goto(`${server.baseURL}/config`);
			await page.waitForTimeout(1000);
			const securityBtn = page.getByRole("button", { name: "Security" });
			await expect(securityBtn).toBeVisible({ timeout: 15000 });
			await securityBtn.click();
		});

		await test.step("Click Remove Password", async () => {
			const removeBtn = page.getByText(/remove password/i).first();
			await expect(removeBtn).toBeVisible({ timeout: 10000 });
			await removeBtn.click();
			await page.waitForTimeout(2000);
		});

		await test.step("Status changes to Unprotected", async () => {
			await expect(page.getByText("Unprotected")).toBeVisible({ timeout: 10000 });
		});

		await test.step("Password input is visible again", async () => {
			await expect(page.locator('input[placeholder="Enter password"]')).toBeVisible();
		});
	});
});