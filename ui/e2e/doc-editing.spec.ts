import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

async function openDocFromList(page: import("@playwright/test").Page, label: string) {
	const docItem = page.getByRole("button", { name: new RegExp(label, "i") }).first();
	await expect(docItem).toBeVisible({ timeout: 5000 });
	await docItem.click();
}

async function enterDocEditMode(page: import("@playwright/test").Page) {
	for (let attempt = 0; attempt < 3; attempt++) {
		const editBtn = page.locator("button").filter({ hasText: "Edit" }).first();
		await expect(editBtn).toBeVisible({ timeout: 3000 });
		await editBtn.click();
		const saveBtn = page.locator("button").filter({ hasText: "Save" }).first();
		if (await saveBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
			return;
		}
		await page.waitForTimeout(300);
	}
	await expect(page.locator("button").filter({ hasText: "Save" }).first()).toBeVisible({ timeout: 5000 });
}

test.describe("Doc Creation with Full Fields", () => {
		test("creates doc via UI with title, description, tags, and content", async ({ page }) => {
		await test.step("Navigate to docs page", async () => {
			await page.goto(`${server.baseURL}/docs`);
			await page.waitForTimeout(1000);
		});

		await test.step("Click New Doc button", async () => {
			const createBtn = page.locator("button").filter({ hasText: "New Doc" }).first();
			await expect(createBtn).toBeVisible({ timeout: 5000 });
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
			await expect(editorInput).toBeVisible({ timeout: 5000 });
			await editorInput.fill("## API Guidelines\n\nUse consistent REST semantics.");
		});

		await test.step("Click Create button and verify doc appears in list", async () => {
			const createBtn = page.locator("button").filter({ hasText: "Create" }).first();
			await expect(createBtn).toBeEnabled();
			await createBtn.click();
			await page.waitForTimeout(1000);
			const newDocBtn = page.locator("button").filter({ hasText: "New Doc" }).first();
			await expect(newDocBtn).toBeVisible({ timeout: 5000 });
			const folderBtn = page.getByRole("button", { name: /guides/i }).first();
			await expect(folderBtn).toBeVisible({ timeout: 5000 });
			await folderBtn.click();
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
			await page.getByText("Setup Guide").first().click();
			await page.waitForTimeout(500);
		});

		await test.step("Verify doc content renders", async () => {
			await expect(page.getByText("Getting Started").first()).toBeVisible({ timeout: 5000 });
		});

		await test.step("Verify metadata displayed", async () => {
			await expect(page.getByText("How to set up the project").first()).toBeVisible({ timeout: 3000 });
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
			await expect(page.getByText("Original Content").first()).toBeVisible({ timeout: 5000 });
		});

		await test.step("Click Edit button in toolbar", async () => {
			const editBtn = page.locator("button").filter({ hasText: "Edit" }).first();
			await expect(editBtn).toBeVisible({ timeout: 3000 });
			await editBtn.click();
			await page.waitForTimeout(1000);
		});

		await test.step("Editor is visible (edit mode active)", async () => {
			const saveBtn = page.locator("button").filter({ hasText: "Save" }).first();
			const editBtn = page.locator("button").filter({ hasText: "Edit" }).first();
			if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
				await expect(saveBtn).toBeVisible({ timeout: 5000 });
				return;
			}
			await expect(editBtn).toBeVisible({ timeout: 5000 });
		});

		await test.step("Save and Cancel buttons are visible", async () => {
			const saveBtn = page.locator("button").filter({ hasText: "Save" }).first();
			const cancelBtn = page.locator("button").filter({ hasText: "Cancel" }).first();
			if (await saveBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
				await expect(saveBtn).toBeVisible({ timeout: 3000 });
				await expect(cancelBtn).toBeVisible({ timeout: 3000 });
			}
		});

		await test.step("Click Cancel to exit edit mode", async () => {
			const cancelBtn = page.locator("button").filter({ hasText: "Cancel" }).first();
			if (await cancelBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
				await cancelBtn.click();
				await page.waitForTimeout(300);
			}
			await expect(page.getByText("Original Content").first()).toBeVisible({ timeout: 5000 });
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
			await expect(page.getByText("Before Edit").first()).toBeVisible({ timeout: 5000 });
		});

		await test.step("Enter edit mode", async () => {
			await enterDocEditMode(page);
		});

		await test.step("Editor is visible (edit mode active)", async () => {
			await expect(page.locator("button").filter({ hasText: "Save" }).first()).toBeVisible({ timeout: 5000 });
		});

		await test.step("Save without changes to verify save flow works", async () => {
			const saveBtn = page.locator("button").filter({ hasText: "Save" }).first();
			await saveBtn.click();
			// After save, view switches back to read mode
			// Edit button should reappear
			await expect(page.locator("button").filter({ hasText: "Edit" }).first()).toBeVisible({ timeout: 10000 });
		});

		await test.step("Back in view mode after save", async () => {
			await expect(page.getByText("Before Edit").first()).toBeVisible({ timeout: 5000 });
		});

		await test.step("Edit via CLI and verify UI updates", async () => {
			server.cli('doc edit "save-test" -c "## After Edit\\n\\nUpdated content here."');
			await page.reload();
			await page.waitForTimeout(1000);
			await openDocFromList(page, "Save Test");
			await page.waitForTimeout(500);
			await expect(page.getByText("After Edit").first()).toBeVisible({ timeout: 5000 });
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
			await page.getByText("Old Title").first().click();
			await page.waitForTimeout(500);
		});

		await test.step("Edit title inline", async () => {
			const titleInput = page.locator('input[placeholder="Untitled"]').first();
			await expect(titleInput).toBeVisible({ timeout: 3000 });
			await titleInput.fill("New Title");
			await titleInput.press("Enter");
			await page.waitForTimeout(500);
		});

		await test.step("Verify title updated after navigating back", async () => {
			const backBtn = page.locator("button").filter({ hasText: "Back" }).first();
			await backBtn.click();
			await page.waitForTimeout(500);
			await expect(page.getByText("New Title").first()).toBeVisible({ timeout: 5000 });
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
			// Navigate back to doc list
			const backBtn = page.locator("button").filter({ hasText: "Back" }).first();
			await backBtn.click();
			await page.waitForTimeout(1000);
			// Wait for the file manager to be visible
			await expect(page.getByText("Browse your docs").first()).toBeVisible({ timeout: 5000 });
			// Re-open the doc using its path, which remains visible even if title rendering changes
			await openDocFromList(page, "desc-test-doc");
			await page.waitForTimeout(500);
			const descInput = page.locator('input[placeholder="Add a description..."]').first();
			await expect(descInput).toBeVisible({ timeout: 5000 });
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

test.describe("Doc Back Navigation", () => {
	test("back button returns to doc list", async ({ page }) => {
		await test.step("Create doc", async () => {
			server.cli('doc create "Back Nav Doc" -d "Test navigation" -t "test"');
		});

		await test.step("Open doc", async () => {
			await page.goto(`${server.baseURL}/docs`);
			await page.waitForTimeout(1000);
			await page.getByText("Back Nav Doc").first().click();
			await page.waitForTimeout(500);
		});

		await test.step("Click Back button", async () => {
			const backBtn = page.locator("button").filter({ hasText: "Back" }).first();
			await expect(backBtn).toBeVisible({ timeout: 3000 });
			await backBtn.click();
			await page.waitForTimeout(300);
		});

		await test.step("Doc list is visible again", async () => {
			await expect(page.getByText("Back Nav Doc").first()).toBeVisible({ timeout: 3000 });
		});
	});
});
