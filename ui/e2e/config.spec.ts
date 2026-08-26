import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Configuration Page", () => {
	test("shows config page with project settings", async ({ page }) => {
		await test.step("Navigate to config page", async () => {
			await page.goto(`${server.baseURL}/config`);
		});

		await test.step("Config page loads", async () => {
			await expect(page.getByText(/config|settings/i).first()).toBeVisible();
		});

		await test.step("Project name field is visible", async () => {
			await expect(page.getByText(/project name|name/i).first()).toBeVisible();
		});
	});

	test("shows board status configuration", async ({ page }) => {
		await test.step("Navigate to config page", async () => {
			await page.goto(`${server.baseURL}/config`);
		});

		await test.step("Board section is visible", async () => {
			const boardSection = page.getByText(/board|statuses/i).first();
			await expect(boardSection).toBeVisible();
		});
	});

	test("displays default task settings", async ({ page }) => {
		await test.step("Navigate to config page", async () => {
			await page.goto(`${server.baseURL}/config`);
		});

		await test.step("Default settings fields are visible", async () => {
			// Look for priority or assignee defaults
			await expect(page.getByText(/priority|assignee|default/i).first()).toBeVisible();
		});
	});

	test("offers no local ONNX embedding source or model picker", async ({ page }) => {
		await page.route("**/api/config", async (route) => {
			if (route.request().method() !== "GET") {
				await route.continue();
				return;
			}
			const response = await route.fetch();
			const body = await response.json();
			body.config = {
				...(body.config || {}),
				// Simulate an unmigrated project still carrying the retired
				// "local" provider value on disk.
				semanticSearch: {
					enabled: true,
					provider: "local",
					model: "gte-small",
				},
			};
			await route.fulfill({ response, json: body });
		});

		await page.goto(`${server.baseURL}/config`);
		await page.getByRole("button", { name: "Search", exact: true }).click();

		await expect(page.getByTestId("local-onnx-unavailable")).toHaveCount(0);
		const provider = page.getByRole("combobox");
		await expect(provider.locator('option[value="local"]')).toHaveCount(0);
		await expect(provider.locator('option[value="ollama"]')).toHaveCount(1);
		await expect(provider.locator('option[value="api"]')).toHaveCount(1);
		// A stale "local" value from an unmigrated config falls back to Ollama
		// rather than leaving the selector on an option that no longer exists.
		await expect(provider).toHaveValue("ollama");
		await expect(page.getByText("HuggingFace ID", { exact: true })).toHaveCount(0);

		const saveRequest = page.waitForRequest(
			(request) => request.url().endsWith("/api/config") && request.method() === "PATCH",
		);
		await page.getByRole("spinbutton").first().fill("768");
		const request = await saveRequest;
		expect(request.postDataJSON().semanticSearch.provider).toBe("ollama");
	});

	test("keeps category navigation and active content usable on mobile", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(`${server.baseURL}/config`);

		const settingsTabs = page.getByRole("tablist", { name: "Settings categories" });
		const generalTab = settingsTabs.getByRole("tab", { name: "General" });
		await expect(settingsTabs).toBeVisible();
		await expect(generalTab).toBeVisible();
		await expect(generalTab).toHaveAttribute("aria-selected", "true");
		await expect(page.getByRole("heading", { name: "Project", exact: true })).toBeVisible();

		const codeTab = settingsTabs.getByRole("tab", { name: "Code", exact: true });
		await codeTab.click();
		await expect(codeTab).toHaveAttribute("aria-selected", "true");
		await expect(page.getByRole("heading", { name: "Language Server Protocol", exact: true })).toBeVisible();

		const codeTabBox = await codeTab.boundingBox();
		expect(codeTabBox).not.toBeNull();
		expect(codeTabBox!.x).toBeGreaterThanOrEqual(0);
		expect(codeTabBox!.x + codeTabBox!.width).toBeLessThanOrEqual(390);

		const viewportOverflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
		);
		expect(viewportOverflow).toBeLessThanOrEqual(1);
	});
});
