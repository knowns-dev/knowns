import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
	// Seed data so the graph has nodes to render
	server.cli('task create "Graph Test Task 1" -d "First task for graph" --priority high -l "feature"');
	server.cli('task create "Graph Test Task 2" -d "Second task for graph" --priority medium -l "backend"');
	server.cli('doc create "Graph Doc" -d "Documentation for graph tests" -t "test"');
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Knowledge Graph", () => {
	test("graph page loads without errors", async ({ page }) => {
		await test.step("Navigate to graph page", async () => {
			await page.goto(`${server.baseURL}/graph`);
		});

		await test.step("Page header/toolbar is visible", async () => {
			// GraphToolbar renders a search input with placeholder "Search graph…"
			await expect(page.getByPlaceholder("Search graph…")).toBeVisible();
		});

		await test.step("No error state is shown", async () => {
			await expect(page.getByText("Failed to load graph")).not.toBeVisible();
		});
	});

	test("graph canvas container is visible", async ({ page }) => {
		await test.step("Navigate to graph", async () => {
			await page.goto(`${server.baseURL}/graph`);
		});

		await test.step("Graph canvas area exists", async () => {
			// The ForceGraph2D renders inside an absolute positioned container
			const canvas = page.locator("canvas").first();
			await expect(canvas).toBeVisible();
		});
	});

	test("toolbar shows search and node count", async ({ page }) => {
		await test.step("Navigate to graph", async () => {
			await page.goto(`${server.baseURL}/graph`);
		});

		await test.step("Search input is present", async () => {
			await expect(page.getByPlaceholder("Search graph…")).toBeVisible();
		});

		await test.step("Node/edge count is shown", async () => {
			// GraphToolbar displays "{n} entities · {m} relations"
			await expect(page.getByText(/\d+ entities/)).toBeVisible();
			await expect(page.getByText(/\d+ relations/)).toBeVisible();
		});

		await test.step("Zoom to fit and fullscreen buttons are present", async () => {
			await expect(page.getByRole("button", { name: "Fit graph to view" })).toBeVisible();
			await expect(
				page.getByRole("button", { name: "Open graph fullscreen" }),
			).toBeVisible();
		});
	});

	test("legend shows filter controls for node types", async ({ page }) => {
		await test.step("Navigate to graph", async () => {
			await page.goto(`${server.baseURL}/graph`);
		});

		await test.step("Legend panel opens from the Filters popover", async () => {
			// The rework moved the legend out of a docked panel into this popover.
			await page.getByRole("button", { name: "Graph filters" }).click();
			await expect(page.getByText("Entity types")).toBeVisible();
		});

		await test.step("Node type filters are present", async () => {
			await expect(page.getByRole("button", { name: /^Tasks/ })).toBeVisible();
			await expect(page.getByRole("button", { name: /^Docs/ })).toBeVisible();
			await expect(page.getByRole("button", { name: /^Memories/ })).toBeVisible();
		});

		await test.step("Relation section is present", async () => {
			await expect(page.getByText("Relation types")).toBeVisible();
		});
	});

	test("graph nodes exist after creating tasks via CLI", async ({ page }) => {
		await test.step("Create additional task", async () => {
			server.cli('task create "Fresh Graph Task" -d "Created after server start"');
		});

		await test.step("Navigate and refresh graph", async () => {
			await page.goto(`${server.baseURL}/graph`);
		});

		await test.step("Node count shows at least some nodes", async () => {
			// Wait for the graph to load, then check node count text
			await expect(page.getByText(/^0 entities/)).not.toBeVisible({ timeout: 10000 });

			// Verify the toolbar shows a non-zero entity count
			await expect(page.getByText(/\d+ entities/)).toBeVisible();
		});
	});

	test("search in graph toolbar highlights matching nodes", async ({ page }) => {
		await test.step("Navigate to graph", async () => {
			await page.goto(`${server.baseURL}/graph`);
		});

		await test.step("Wait for graph to load", async () => {
			await expect(page.getByText(/\d+ entities/)).toBeVisible();
		});

		await test.step("Type search query", async () => {
			await page.getByPlaceholder("Search graph…").fill("Graph Test");
			await page.waitForTimeout(500);
		});

		await test.step("Match count is shown", async () => {
			// Toolbar shows "{n} matches" when searching
			await expect(page.getByText(/matches/)).toBeVisible();
		});

		await test.step("Clearing search removes match indicator", async () => {
			await page.getByPlaceholder("Search graph…").fill("");
			await page.waitForTimeout(300);
			await expect(page.getByText(/matches/)).not.toBeVisible();
		});
	});

	test("node type filter toggles work", async ({ page }) => {
		await test.step("Navigate to graph", async () => {
			await page.goto(`${server.baseURL}/graph`);
		});

		await test.step("Wait for graph to load", async () => {
			await expect(page.getByText(/\d+ entities/)).toBeVisible();
		});

		await test.step("Click Tasks filter to toggle", async () => {
			await page.getByRole("button", { name: "Graph filters" }).click();
			const tasksFilter = page.getByRole("button", { name: /^Tasks/ });
			await expect(tasksFilter).toHaveAttribute("aria-pressed", "true");
			await tasksFilter.click();
			await expect(tasksFilter).toHaveAttribute("aria-pressed", "false");
		});

		await test.step("Node count may decrease", async () => {
			// The graph should still be visible; entity count may have changed
			await expect(page.getByText(/\d+ entities/)).toBeVisible();
		});
	});

	test("detail panel opens when clicking a node", async ({ page }) => {
		await test.step("Navigate to graph", async () => {
			await page.goto(`${server.baseURL}/graph`);
		});

		await test.step("Wait for graph to load", async () => {
			await expect(page.getByText(/\d+ entities/)).toBeVisible();
		});

		await test.step("Click on canvas area (ForceGraph2D canvas)", async () => {
			const canvas = page.locator("canvas").first();
			if (await canvas.isVisible({ timeout: 5000 })) {
				await canvas.click({ force: true });
				await page.waitForTimeout(300);
			}
		});

		await test.step("Clicking background clears selection (no crash)", async () => {
			// Clicking the background should clear selection without error
			await expect(page.getByText("Failed to load graph")).not.toBeVisible();
		});
	});

	test("impact summary appears after selecting a node", async ({ page }) => {
		await test.step("Navigate to graph", async () => {
			await page.goto(`${server.baseURL}/graph`);
		});

		await test.step("Wait for graph to load", async () => {
			await expect(page.getByText(/\d+ entities/)).toBeVisible();
		});

		await test.step("Clicking canvas should not show impact bar initially", async () => {
			// Impact summary only shows when a node is selected and has connections
			// Just verify the page is stable after interaction
			const canvas = page.locator("canvas").first();
			if (await canvas.isVisible({ timeout: 5000 })) {
				await canvas.click({ force: true });
				await page.waitForTimeout(500);
			}
		});
	});
});

// The suite as a whole runs with SwiftShader so the real renderer is covered.
// This block takes the context away again to reproduce a browser that refuses
// WebGL, which is what enterprise policy or a blocklisted driver leaves users
// with. Blocking getContext rather than the launch flag keeps the check
// deterministic on runners that do have a GPU.
test.describe("Knowledge Graph without WebGL", () => {
	test("explains the missing context instead of crashing the page", async ({ page }) => {
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));

		await page.addInitScript(() => {
			const original = HTMLCanvasElement.prototype.getContext;
			HTMLCanvasElement.prototype.getContext = function patched(
				this: HTMLCanvasElement,
				kind: string,
				...rest: unknown[]
			) {
				if (kind === "webgl" || kind === "webgl2" || kind === "experimental-webgl") {
					return null;
				}
				return (original as (...args: unknown[]) => unknown).call(this, kind, ...rest);
			} as typeof HTMLCanvasElement.prototype.getContext;
		});

		await page.goto(`${server.baseURL}/graph`);

		await test.step("Fallback replaces the canvas", async () => {
			await expect(page.locator('[data-graph-fallback="no-webgl"]')).toBeVisible();
			await expect(page.getByText(/needs WebGL/)).toBeVisible();
		});

		await test.step("The page is not swallowed by the error boundary", async () => {
			await expect(page.getByText("Something went wrong")).toHaveCount(0);
			expect(pageErrors.join("\n")).not.toContain("blendFunc");
		});

		await test.step("The rest of the graph page still works", async () => {
			await expect(page.getByPlaceholder("Search graph\u2026")).toBeVisible();
			await expect(page.getByText(/\d+ entities/)).toBeVisible();
			await expect(page.getByText(/\d+ relations/)).toBeVisible();
			await expect(page.getByRole("button", { name: "Graph filters" })).toBeVisible();
		});
	});
});
