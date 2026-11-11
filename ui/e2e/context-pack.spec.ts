import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
	server.cli('doc create "Pelican Handbook" -d "How pelicans are fed" -c "Pelicans eat fish every morning."');
	server.cli('task create "Feed the pelican" -d "Buy fish for the pelican"');
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Context pack", () => {
	test("builds a pack and links each item to its page", async ({ page }) => {
		await page.goto(`${server.baseURL}/context`);
		await expect(page.getByText("Run a query to see")).toBeVisible();
		await page.getByRole("textbox", { name: "Retrieve query" }).fill("pelican");
		await page.getByRole("button", { name: "Build pack" }).click();

		const items = page.getByRole("list", { name: "Pack items" });
		await expect(items.getByRole("link", { name: "Pelican Handbook" })).toBeVisible();
		await expect(items.getByRole("link", { name: "Feed the pelican" })).toBeVisible();
		await expect(items.getByText(/~\d+ tokens/).first()).toBeVisible();

		await items.getByRole("link", { name: "Pelican Handbook" }).click();
		await expect(page).toHaveURL(/\/docs\//);
	});

	test("shows an empty state when nothing matches", async ({ page }) => {
		await page.goto(`${server.baseURL}/context`);
		await page.getByRole("textbox", { name: "Retrieve query" }).fill("zzqqxxnothingmatches");
		await page.getByRole("button", { name: "Build pack" }).click();
		await expect(page.getByText("The pack is empty.")).toBeVisible();
	});

	test("shows an error state with retry when retrieve fails", async ({ page }) => {
		await page.route("**/api/retrieve*", (route) =>
			route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }),
		);
		await page.goto(`${server.baseURL}/context`);
		await page.getByRole("textbox", { name: "Retrieve query" }).fill("pelican");
		await page.getByRole("button", { name: "Build pack" }).click();
		await expect(page.getByRole("alert")).toContainText("boom");
	});

	test("is reachable from the sidebar", async ({ page }) => {
		await page.goto(server.baseURL);
		await page.getByRole("link", { name: "Context pack" }).first().click();
		await expect(page).toHaveURL(/\/context$/);
	});
});
