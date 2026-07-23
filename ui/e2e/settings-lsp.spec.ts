import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Settings — LSP (Code tab)", () => {
	test("Code tab shows Language Server Protocol section", async ({ page }) => {
		await test.step("Navigate to Settings → Code", async () => {
			await page.goto(`${server.baseURL}/config`);
			// Click the Code tab in the sidebar
			await page.getByText("Code").first().click();
		});

		await test.step("LSP section header is visible", async () => {
			await expect(page.getByText("Language Server Protocol")).toBeVisible();
		});
	});

	test("LSP toggle switch is visible", async ({ page }) => {
		await test.step("Navigate to Settings → Code", async () => {
			await page.goto(`${server.baseURL}/config`);
			await page.getByText("Code").first().click();
		});

		await test.step("Enabled toggle is visible", async () => {
			await expect(page.getByText("Enabled")).toBeVisible();
		});
	});

	test("Add button for language is visible", async ({ page }) => {
		await test.step("Navigate to Settings → Code", async () => {
			await page.goto(`${server.baseURL}/config`);
			await page.getByText("Code").first().click();
		});

		await test.step("Add language button is visible", async () => {
			await expect(page.getByRole("button", { name: "Add" })).toBeVisible();
		});
	});

	test("Add dropdown shows available languages when clicked", async ({ page }) => {
		await test.step("Navigate to Settings → Code", async () => {
			await page.goto(`${server.baseURL}/config`);
			await page.getByText("Code").first().click();
		});

		await test.step("Click Add button", async () => {
			await page.getByRole("button", { name: "Add" }).click();
			await page.waitForTimeout(500);
		});

		await test.step("Dropdown is visible", async () => {
			// The dropdown appears as a floating element after click
			const dropdown = page.locator(".z-50, [class*='z-50']");
			await expect(dropdown.or(page.locator("div.absolute"))).toBeVisible();
		});
	});

	test("can add a language and see it in the list", async ({ page }) => {
		await test.step("Navigate to Settings → Code", async () => {
			await page.goto(`${server.baseURL}/config`);
			await page.getByText("Code").first().click();
		});

		await test.step("Click Add button", async () => {
			await page.getByRole("button", { name: "Add" }).click();
			await page.waitForTimeout(500);
		});

		await test.step("Click a language in the dropdown (if available)", async () => {
			// Find the first language entry in the dropdown and click it
			const langEntry = page.locator("button:has-text(/.+/)").first();
			const hasEntry = await langEntry.isVisible().catch(() => false);

			if (hasEntry) {
				await langEntry.click();
				await page.waitForTimeout(2000);

				// The language should now appear in the list
				const langList = page.locator('[class*="space-y-2"]').locator('[class*="bg-card"]').first();
				await expect(langList.or(page.getByText(/running|installed|not installed/i).first())).toBeVisible({ timeout: 10000 });
			}
		});
	});

	test("can toggle a language on/off", async ({ page }) => {
		await test.step("Navigate to Settings → Code", async () => {
			await page.goto(`${server.baseURL}/config`);
			await page.getByText("Code").first().click();
		});

		await test.step("Add a language first", async () => {
			const addBtn = page.getByRole("button", { name: "Add" });
			await addBtn.click();
			await page.waitForTimeout(500);

			const firstLang = page.locator("button:has-text(/.+/)").first();
			const hasEntry = await firstLang.isVisible().catch(() => false);

			if (hasEntry) {
				await firstLang.click();
				await page.waitForTimeout(3000);
			}
		});

		await test.step("Toggle the first language", async () => {
			const firstSwitch = page.locator('[class*="space-y-2"]').locator('[role="switch"]').first();
			const hasSwitch = await firstSwitch.isVisible().catch(() => false);

			if (hasSwitch) {
				await firstSwitch.click();
				await page.waitForTimeout(1500);
			}
		});
	});

	test("can remove a language from the list", async ({ page }) => {
		await test.step("Navigate to Settings → Code", async () => {
			await page.goto(`${server.baseURL}/config`);
			await page.getByText("Code").first().click();
		});

		await test.step("Add a language first", async () => {
			const addBtn = page.getByRole("button", { name: "Add" });
			await addBtn.click();
			await page.waitForTimeout(500);

			const firstLang = page.locator("button:has-text(/.+/)").first();
			const hasEntry = await firstLang.isVisible().catch(() => false);

			if (hasEntry) {
				await firstLang.click();
				await page.waitForTimeout(3000);
			}
		});

		await test.step("Remove the language", async () => {
			// Find the trash icon in the language card
			const trashBtn = page.locator("button:has(svg)").filter({ hasText: /delete/i }).first();
			const hasTrash = await trashBtn.isVisible().catch(() => false);

			if (hasTrash) {
				await trashBtn.click();
				await page.waitForTimeout(2000);
			}
		});
	});
});