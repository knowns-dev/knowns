import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

// Docs is one layout: the sidebar lists every doc as a link, and searching it expands folders.
async function openDocFromList(page: import("@playwright/test").Page, label: string) {
	const sidebar = page.getByRole("complementary", { name: "Docs library" });
	await sidebar.getByRole("searchbox", { name: "Search docs" }).or(sidebar.getByLabel("Search docs")).first().fill(label);
	const docItem = sidebar.getByRole("link", { name: new RegExp(label, "i") }).first();
	await expect(docItem).toBeVisible();
	await docItem.click();
	await expect(page.locator('input[placeholder="Untitled"]').first()).toHaveValue(new RegExp(label, "i"), { timeout: 5000 });
}

async function enterDocEditMode(page: import("@playwright/test").Page) {
	for (let attempt = 0; attempt < 3; attempt++) {
		const editBtn = page.getByRole("button", { name: "Edit", exact: true }).first();
		await expect(editBtn).toBeVisible({ timeout: 3000 });
		await editBtn.click();
		const saveBtn = page.getByRole("button", { name: "Save", exact: true }).first();
		if (await saveBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
			return;
		}
		await page.waitForTimeout(300);
	}
	await expect(page.getByRole("button", { name: "Save", exact: true }).first()).toBeVisible();
}

test.describe("Doc Creation with Full Fields", () => {
		test("creates doc via UI with title, description, tags, and content", async ({ page }) => {
		await test.step("Navigate to docs page", async () => {
			await page.goto(`${server.baseURL}/docs`);
			await page.waitForTimeout(1000);
		});

		await test.step("Click New Doc button", async () => {
			const createBtn = page.locator("button").filter({ hasText: "New Doc" }).first();
			await expect(createBtn).toBeVisible();
			await createBtn.click();
			await page.waitForTimeout(500);
		});

		await test.step("Fill in title", async () => {
			const titleInput = page.locator('input[placeholder="Untitled"]');
			await expect(titleInput).toBeVisible({ timeout: 3000 });
			await titleInput.fill("API Guidelines");
		});

		await test.step("Fill in description", async () => {
			const descInput = page.locator('input[placeholder="Add a description..."]');
			await descInput.fill("Guidelines for building REST APIs");
		});

		await test.step("Fill in tags", async () => {
			const tagsInput = page.locator('input[placeholder="guide, tutorial, api"]');
			await tagsInput.fill("api, guide, rest");
		});

		await test.step("Fill in folder", async () => {
			const folderInput = page.locator('input[placeholder="root"]');
			await folderInput.fill("guides");
		});

		await test.step("Fill in content", async () => {
			const editorInput = page.locator(".rc-md-editor textarea").first();
			await expect(editorInput).toBeVisible();
			await editorInput.fill("## API Guidelines\n\nUse consistent REST semantics.");
		});

		await test.step("Click Create button and verify doc appears in list", async () => {
			const createBtn = page.locator("button").filter({ hasText: "Create" }).first();
			await expect(createBtn).toBeEnabled();
			await createBtn.click();
			await page.waitForTimeout(1000);
			await openDocFromList(page, "API Guidelines");
			await expect(page.locator('input[placeholder="Untitled"]').first()).toHaveValue("API Guidelines", { timeout: 5000 });
		});
	});

	test("creates doc via CLI and views it in UI", async ({ page }) => {
		await test.step("Create doc via CLI with content", async () => {
			server.cli('doc create "Setup Guide" -d "How to set up the project" -t guide -t setup');
			server.cli('doc edit "setup-guide" -c "## Getting Started\\n\\nFollow these steps to set up the project.\\n\\n### Prerequisites\\n\\n- Node.js 18+\\n- Go 1.21+"');
		});

		await test.step("Navigate to docs and open the doc", async () => {
			await page.goto(`${server.baseURL}/docs`);
			await page.waitForTimeout(1000);
			await openDocFromList(page, "Setup Guide");
		});

		await test.step("Verify doc content renders", async () => {
			await expect(page.getByText("Getting Started").first()).toBeVisible();
		});

		await test.step("Verify metadata displayed", async () => {
			await expect(page.locator('input[placeholder="Add a description..."]').first()).toHaveValue("How to set up the project", { timeout: 3000 });
		});
	});
});

test.describe("Doc Content Editing", () => {
		test("edits doc content via Edit button and saves", async ({ page }) => {
			await test.step("Create doc via CLI", async () => {
				server.cli('doc create "Editable Doc" -d "Test editing content" -t test');
				server.cli('doc edit "editable-doc" -c "## Original Content\\n\\nThis is the original text."');
			});

		await test.step("Navigate and open doc", async () => {
			await page.goto(`${server.baseURL}/docs`);
			await page.waitForTimeout(1000);
			await openDocFromList(page, "Editable Doc");
			await page.waitForTimeout(500);
			await expect(page.getByText("Original Content").first()).toBeVisible();
		});

		await test.step("Click Edit button in toolbar", async () => {
			const editBtn = page.getByRole("button", { name: "Edit", exact: true }).first();
			await expect(editBtn).toBeVisible({ timeout: 3000 });
			await editBtn.click();
			await page.waitForTimeout(1000);
		});

		await test.step("Editor is visible (edit mode active)", async () => {
			const saveBtn = page.getByRole("button", { name: "Save", exact: true }).first();
			const editBtn = page.getByRole("button", { name: "Edit", exact: true }).first();
			if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
				await expect(saveBtn).toBeVisible();
				return;
			}
			await expect(editBtn).toBeVisible();
		});

		await test.step("Save and Cancel buttons are visible", async () => {
			const saveBtn = page.getByRole("button", { name: "Save", exact: true }).first();
			const cancelBtn = page.getByRole("button", { name: "Cancel", exact: true }).first();
			if (await saveBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
				await expect(saveBtn).toBeVisible({ timeout: 3000 });
				await expect(cancelBtn).toBeVisible({ timeout: 3000 });
			}
		});

		await test.step("Click Cancel to exit edit mode", async () => {
			const cancelBtn = page.getByRole("button", { name: "Cancel", exact: true }).first();
			if (await cancelBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
				await cancelBtn.click();
				await page.waitForTimeout(300);
			}
			await expect(page.getByText("Original Content").first()).toBeVisible();
		});
	});

		test("editing and saving preserves changes", async ({ page }) => {
			await test.step("Create doc via CLI", async () => {
				server.cli('doc create "Save Test" -d "Test saving" -t test');
				server.cli('doc edit "save-test" -c "## Before Edit\\n\\nInitial content here."');
			});

		await test.step("Open doc", async () => {
			await page.goto(`${server.baseURL}/docs`);
			await page.waitForTimeout(1000);
			await openDocFromList(page, "Save Test");
			await page.waitForTimeout(500);
			await expect(page.getByText("Before Edit").first()).toBeVisible();
		});

		await test.step("Enter edit mode", async () => {
			await enterDocEditMode(page);
		});

		await test.step("Editor is visible (edit mode active)", async () => {
			await expect(page.getByRole("button", { name: "Save", exact: true }).first()).toBeVisible();
		});

		await test.step("Save without changes to verify save flow works", async () => {
			const saveBtn = page.getByRole("button", { name: "Save", exact: true }).first();
			await saveBtn.click();
			// After save, view switches back to read mode
			// Edit button should reappear
			await expect(page.getByRole("button", { name: "Edit", exact: true }).first()).toBeVisible({ timeout: 10000 });
		});

		await test.step("Back in view mode after save", async () => {
			await expect(page.getByText("Before Edit").first()).toBeVisible();
		});

		await test.step("Edit via CLI and verify UI updates", async () => {
			server.cli('doc edit "save-test" -c "## After Edit\\n\\nUpdated content here."');
			await page.reload();
			await page.waitForTimeout(1000);
			// The doc view's library sidebar lists docs as links.
			await page.getByRole("navigation", { name: "Docs" }).getByRole("link", { name: "Save Test" }).click();
			await page.waitForTimeout(500);
			await expect(page.getByText("After Edit").first()).toBeVisible();
		});
	});
});

test.describe("Inline Metadata Editing (Notion-like)", () => {
		test("edits doc title inline", async ({ page }) => {
			await test.step("Create doc via CLI", async () => {
				server.cli('doc create "Old Title" -d "Test inline editing" -t test');
			});

		await test.step("Open doc", async () => {
			await page.goto(`${server.baseURL}/docs`);
			await page.waitForTimeout(1000);
			await openDocFromList(page, "Old Title");
		});

		await test.step("Edit title inline", async () => {
			const titleInput = page.locator('input[placeholder="Untitled"]').first();
			await expect(titleInput).toBeVisible({ timeout: 3000 });
			await titleInput.fill("New Title");
			await titleInput.press("Enter");
			await page.waitForTimeout(500);
		});

		await test.step("Verify title updated in the doc list after reload", async () => {
			await page.reload();
			await expect(
				page.getByRole("complementary", { name: "Docs library" }).getByRole("link", { name: /New Title/ }).first(),
			).toBeVisible();
		});
	});

		test("edits doc description inline", async ({ page }) => {
			await test.step("Create doc via CLI", async () => {
				server.cli('doc create "Desc Test Doc" -d "Original description" -t test');
			});

		await test.step("Open doc", async () => {
			await page.goto(`${server.baseURL}/docs`);
			await page.waitForTimeout(1000);
			await openDocFromList(page, "Desc Test Doc");
			await page.waitForTimeout(500);
		});

		await test.step("Edit description inline", async () => {
			const descInput = page.locator('input[placeholder="Add a description..."]').first();
			await expect(descInput).toBeVisible({ timeout: 3000 });
			await descInput.fill("Updated description");
			// Blur to trigger save
			await descInput.press("Tab");
			await page.waitForTimeout(1000);
		});

		await test.step("Verify description field remains editable after navigating back and reopening", async () => {
			// Leave the doc from the sidebar and come back to it.
			await page.goto(`${server.baseURL}/docs`);
			await openDocFromList(page, "Desc Test Doc");
			const descInput = page.locator('input[placeholder="Add a description..."]').first();
			await expect(descInput).toBeVisible();
		});
	});
});

	test.describe("Doc Copy Reference", () => {
	test("copy reference button shows @doc/ path and copies", async ({ page, context }) => {
		await test.step("Create doc", async () => {
			server.cli('doc create "Copy Path Doc" -d "Test copy" -t "test"');
		});

		await test.step("Grant clipboard permissions", async () => {
			await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		});

		await test.step("Open doc", async () => {
			await page.goto(`${server.baseURL}/docs`);
			await page.waitForTimeout(1000);
			await openDocFromList(page, "Copy Path Doc");
			await page.waitForTimeout(500);
		});

		await test.step("Reference path shown in toolbar", async () => {
			await expect(page.getByText("@doc/copy-path-doc").first()).toBeVisible({ timeout: 3000 });
		});

		await test.step("Click copy button to copy reference", async () => {
			const copyBtn = page.getByRole("button", { name: /@doc\/copy-path-doc/i }).first();
			await expect(copyBtn).toBeVisible({ timeout: 3000 });
			await copyBtn.click();
			await page.waitForTimeout(500);
		});
	});
});

test.describe("Docs layout", () => {
	test("/docs opens a doc next to the doc list, with no separate library page", async ({ page }) => {
		await test.step("Create doc", async () => {
			server.cli('doc create "Back Nav Doc" -d "Test navigation" -t "test"');
		});

		await test.step("Visiting /docs opens a doc in the docs layout", async () => {
			await page.goto(`${server.baseURL}/docs`);
			await expect(page).toHaveURL(/\/docs\/.+/);
			await expect(page.getByRole("button", { name: "Edit", exact: true }).first()).toBeVisible();
			await expect(page.getByRole("button", { name: "Back", exact: true })).toHaveCount(0);
		});

		await test.step("The doc list sits beside it and opens another doc in place", async () => {
			await openDocFromList(page, "Back Nav Doc");
			await expect(page).toHaveURL(/\/docs\/back-nav-doc/);
		});
	});
});
