import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startServer, type TestServer } from "./helpers";

// Import management was removed (D8, extended to the web API by TSR-0MM0QC). Imports already in
// .knowns/imports stay listed and viewable; the page offers no way to add, sync or remove one.

// Generous: the first page load (lazy chunks, project bootstrap) is slow on a loaded machine.
const VISIBLE = { timeout: 30_000 };
let server: TestServer;

function put(rel: string, text: string): void {
	const p = join(server.projectDir, ".knowns", "imports", rel);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, text);
}

test.beforeAll(async () => {
	server = await startServer();
	put(
		"loc/_import.json",
		JSON.stringify({ source: "/src/shared-docs", type: "local", importedAt: "2026-10-01T10:00:00Z" }),
	);
	put("loc/docs/guide.md", "---\ntitle: Shared guide\n---\n\nBody.\n");
	put(
		"upstream/_import.json",
		JSON.stringify({
			source: "https://example.invalid/team/kb.git",
			type: "git",
			ref: "main",
			lastSync: "2026-10-02T09:30:00Z",
		}),
	);
	put("upstream/templates/t.md", "x\n");
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Imports page (read-only)", () => {
	test("lists existing imports without add or sync actions", async ({ page }) => {
		await page.goto(`${server.baseURL}/imports`);
		await expect(page.getByRole("heading", { name: "Imports" })).toBeVisible(VISIBLE);
		await expect(page.getByText("/src/shared-docs")).toBeVisible(VISIBLE);
		await expect(page.getByText("https://example.invalid/team/kb.git")).toBeVisible(VISIBLE);
		await expect(page.getByRole("button", { name: /add import|sync all|add your first import/i })).toHaveCount(0);
		await expect(page.locator("svg.lucide-refresh-cw")).toHaveCount(0);
	});

	test("shows an import's details and files without sync or remove actions", async ({ page }) => {
		await page.goto(`${server.baseURL}/imports`);
		await page.getByText("/src/shared-docs").click(VISIBLE);
		await expect(page.getByRole("heading", { name: "loc" })).toBeVisible(VISIBLE);
		await expect(page.getByText("Imported Files")).toBeVisible(VISIBLE);
		// The tree lists the docs folder (its files load collapsed).
		await expect(page.getByText("Docs (1)")).toBeVisible(VISIBLE);
		await expect(page.locator("svg.lucide-refresh-cw")).toHaveCount(0);
		await expect(page.locator("svg.lucide-trash-2")).toHaveCount(0);
		await expect(page.getByRole("button", { name: /remove|sync/i })).toHaveCount(0);
	});
});
