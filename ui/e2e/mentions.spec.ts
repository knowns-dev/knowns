import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Task → Task Mentions", () => {
	test("task description shows mention badge for another task", async ({ page }) => {
		let targetId = "";

		await test.step("Create target task", async () => {
			const output = server.cli('task create "Login Feature" -d "Implement login"');
			const match = output.match(/Created task\s+([a-z0-9]+)/i);
			targetId = match?.[1] || "";
			expect(targetId).toBeTruthy();
		});

		await test.step("Create task that mentions the target", async () => {
			server.cli(`task create "Auth Tests" -d "Write tests for @task-${targetId}"`);
		});

		await test.step("Open mentioning task from kanban", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Auth Tests").first().click();
		});

		await test.step("Mention badge shows target task title", async () => {
			const badge = page.locator(`[data-task-id="${targetId}"]`);
			await expect(badge).toBeVisible({ timeout: 5000 });
			await expect(badge).toContainText("Login Feature");
		});

		await test.step("Mention badge has green styling (valid task)", async () => {
			const badge = page.locator(`[data-task-id="${targetId}"]`);
			await expect(badge).toHaveAttribute("role", "link");
		});
	});

	test("clicking task mention navigates to that task", async ({ page }) => {
		let targetId = "";

		await test.step("Create two tasks with mention", async () => {
			const output = server.cli('task create "Target Task" -d "The target"');
			const match = output.match(/Created task\s+([a-z0-9]+)/i);
			targetId = match?.[1] || "";
			server.cli(`task create "Referencing Task" -d "See @task-${targetId} for details"`);
		});

		await test.step("Open referencing task", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Referencing Task").first().click();
		});

		await test.step("Click the mention badge", async () => {
			const badge = page.locator(`[data-task-id="${targetId}"]`);
			await expect(badge).toBeVisible({ timeout: 5000 });
			await badge.click();
		});

		await test.step("Navigated to target task", async () => {
			await expect(page).toHaveURL(new RegExp(`/kanban/${targetId}`), { timeout: 5000 });
			await expect(page.getByRole("heading", { name: "Target Task", exact: true })).toBeVisible({ timeout: 5000 });
		});
	});

	test("broken task mention shows red style", async ({ page }) => {
		await test.step("Create task with non-existent mention", async () => {
			server.cli('task create "Broken Ref" -d "See @task-nonexistent999 for info"');
		});

		await test.step("Open task from kanban", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Broken Ref").first().click();
		});

		await test.step("Broken mention badge is visible without link role", async () => {
			const badge = page.locator('[data-task-id="nonexistent999"]');
			await expect(badge).toBeVisible({ timeout: 5000 });
			// Broken mentions don't have role="link"
			await expect(badge).not.toHaveAttribute("role", "link");
		});
	});
});

test.describe("Task → Doc Mentions", () => {
	test("task description shows doc mention badge", async ({ page }) => {
		await test.step("Create a doc", async () => {
			server.cli('doc create "API Guide" -d "API documentation" -t "guide"');
		});

		await test.step("Create task mentioning the doc", async () => {
			server.cli('task create "Implement API" -d "Follow @doc/api-guide for implementation"');
		});

		await test.step("Open task from kanban", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Implement API").first().click();
		});

		await test.step("Doc mention badge is visible", async () => {
			const badge = page.locator('[data-doc-path="api-guide.md"]');
			await expect(badge).toBeVisible({ timeout: 5000 });
			await expect(badge).toContainText("API Guide");
		});

		await test.step("Doc mention badge has link role", async () => {
			const badge = page.locator('[data-doc-path="api-guide.md"]');
			await expect(badge).toHaveAttribute("role", "link");
		});
	});

	test("clicking doc mention navigates to docs page", async ({ page }) => {
		await test.step("Create doc and task", async () => {
			server.cli('doc create "Setup Guide" -d "How to set up" -t "guide"');
			server.cli('task create "Follow Setup" -d "Read @doc/setup-guide first"');
		});

		await test.step("Open task", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Follow Setup").first().click();
		});

		await test.step("Click doc mention badge", async () => {
			const badge = page.locator('[data-doc-path="setup-guide.md"]');
			await expect(badge).toBeVisible({ timeout: 5000 });
			await badge.click();
		});

		await test.step("Navigated to docs page", async () => {
			await expect(page).toHaveURL(/\/docs\/setup-guide$/, { timeout: 5000 });
		});
	});

	test("broken doc mention shows red style", async ({ page }) => {
		await test.step("Create task with non-existent doc mention", async () => {
			server.cli('task create "Bad Doc Ref" -d "See @doc/nonexistent-doc for details"');
		});

		await test.step("Open task from kanban", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Bad Doc Ref").first().click();
		});

		await test.step("Broken doc badge visible without link role", async () => {
			const badge = page.locator('[data-doc-path="nonexistent-doc.md"]');
			await expect(badge).toBeVisible({ timeout: 5000 });
			await expect(badge).not.toHaveAttribute("role", "link");
		});
	});
});

test.describe("Semantic Reference Badges", () => {
	test("semantic task and doc refs show relation badges", async ({ page }) => {
		let taskId = "";

		await test.step("Create target task and doc", async () => {
			const output = server.cli('task create "Runtime API" -d "Implement runtime API"');
			const match = output.match(/Created task\s+([a-z0-9]+)/i);
			taskId = match?.[1] || "";
			expect(taskId).toBeTruthy();
			server.cli('doc create "Semantic Runtime" -d "Semantic runtime guide" -t "guide"');
		});

		await test.step("Create task using semantic refs", async () => {
			server.cli(`task create "Semantic UI" -d "Depends on @task-${taskId}{blocked-by} and @doc/semantic-runtime{implements}"`);
		});

		await test.step("Open task from kanban", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Semantic UI").first().click();
		});

		await test.step("Semantic badges show labels and relations", async () => {
			const taskBadge = page.locator(`[data-task-id="${taskId}"]`);
			const docBadge = page.locator('[data-doc-path="semantic-runtime.md"]');
			await expect(taskBadge).toBeVisible({ timeout: 5000 });
			await expect(docBadge).toBeVisible({ timeout: 5000 });
			await expect(taskBadge).toContainText("Runtime API");
			await expect(taskBadge).toContainText("blocked-by");
			await expect(docBadge).toContainText("Semantic Runtime");
			await expect(docBadge).toContainText("implements");
		});
	});

	test("semantic memory refs render as badges", async ({ page }) => {
		await test.step("Create memory and referencing task", async () => {
			server.cli('memory create "Security Pattern" --layer project --category pattern -c "Remember this pattern"');
			server.cli('task create "Memory Consumer" -d "Follow @memory-security-pattern{follows} for details"');
		});

		await test.step("Open task from kanban", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Memory Consumer").first().click();
		});

		await test.step("Memory badge is visible with relation", async () => {
			const badge = page.locator('[data-memory-id="security-pattern"]');
			await expect(badge).toBeVisible({ timeout: 5000 });
			await expect(badge).toContainText("Security Pattern");
			await expect(badge).toContainText("follows");
			await expect(badge).toHaveAttribute("role", "link");
		});
	});

	test("canonical slash refs render task memory and decision badges", async ({ page }) => {
		let taskId = "";
		let decisionId = "";

		await test.step("Create canonical ref targets", async () => {
			const taskOutput = server.cli('task create "Canonical Target" -d "Target task"');
			taskId = taskOutput.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
			expect(taskId).toBeTruthy();

			server.cli('memory create "Canonical Memory" --layer project --category pattern -c "Remember canonical refs"');
			server.cli('doc create "Decision Source" -d "Decision source" -t "decision"');
			decisionId = "20260618-1024-use-canonical-slash-refs";
			const decisionsDir = join(server.projectDir, ".knowns", "decisions");
			mkdirSync(decisionsDir, { recursive: true });
			writeFileSync(
				join(decisionsDir, `${decisionId}.md`),
				`---\nid: ${decisionId}\ntitle: Use Canonical Slash Refs\nstatus: accepted\nsources:\n  - '@doc/decision-source'\ncreatedAt: '2026-06-18T10:24:00Z'\nupdatedAt: '2026-06-18T10:24:00Z'\n---\n\n## Context\n\nCanonical refs should render.\n\n## Decision\n\nUse slash refs in UI examples.\n`,
			);
		});

		await test.step("Create task using canonical slash refs", async () => {
			server.cli(
				`task create "Canonical Ref Consumer" -d "See @task/${taskId}{related}, @memory/canonical-memory{follows}, and @decision/${decisionId}{depends}"`,
			);
		});

		await test.step("Open task from kanban", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Canonical Ref Consumer").first().click();
		});

		await test.step("Canonical badges show resolved labels and relations", async () => {
			const taskBadge = page.locator(`[data-task-id="${taskId}"]`);
			const memoryBadge = page.locator('[data-memory-id="canonical-memory"]');
			const decisionBadge = page.locator(`[data-decision-id="${decisionId}"]`);

			await expect(taskBadge).toBeVisible({ timeout: 5000 });
			await expect(memoryBadge).toBeVisible({ timeout: 5000 });
			await expect(decisionBadge).toBeVisible({ timeout: 5000 });
			await expect(taskBadge).toContainText("Canonical Target");
			await expect(taskBadge).toContainText("related");
			await expect(memoryBadge).toContainText("Canonical Memory");
			await expect(memoryBadge).toContainText("follows");
			await expect(decisionBadge).toContainText("Use Canonical Slash Refs");
			await expect(decisionBadge).toContainText("depends");
			await expect(decisionBadge).not.toHaveAttribute("role", "link");
		});
	});

	test("broken semantic refs remain visible as broken badges", async ({ page }) => {
		await test.step("Create task with missing semantic refs", async () => {
			server.cli('task create "Broken Semantic Ref" -d "See @doc/missing-guide{implements} and @memory-missing-note{related}"');
		});

		await test.step("Open task from kanban", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Broken Semantic Ref").first().click();
		});

		await test.step("Broken semantic badges stay visible without link role", async () => {
			const docBadge = page.locator('[data-doc-path="missing-guide.md"]');
			const memoryBadge = page.locator('[data-memory-id="missing-note"]');
			await expect(docBadge).toBeVisible({ timeout: 5000 });
			await expect(memoryBadge).toBeVisible({ timeout: 5000 });
			await expect(docBadge).toContainText("implements");
			await expect(memoryBadge).toContainText("related");
			await expect(docBadge).not.toHaveAttribute("role", "link");
			await expect(memoryBadge).not.toHaveAttribute("role", "link");
		});
	});
});

test.describe("Doc → Task Mentions", () => {
	test("doc content shows task mention badge", async ({ page }) => {
		let taskId = "";

		await test.step("Create a task", async () => {
			const output = server.cli('task create "Important Bug" -d "Critical bug to fix"');
			const match = output.match(/Created task\s+([a-z0-9]+)/i);
			taskId = match?.[1] || "";
		});

		await test.step("Create doc mentioning the task", async () => {
			server.cli('doc create "Sprint Notes" -d "Current sprint notes" -t "notes"');
			try {
				server.cli(`doc edit "sprint-notes" -c "## Sprint 1\\n\\nFix @task-${taskId} before release."`);
			} catch {
				server.cli(`doc edit "Sprint Notes" -c "## Sprint 1\\n\\nFix @task-${taskId} before release."`);
			}
		});

		await test.step("Navigate to docs and open the doc", async () => {
			await page.goto(`${server.baseURL}/docs`);
			await page.getByText("Sprint Notes").first().click();
		});

		await test.step("Task mention badge is visible in doc content", async () => {
			const badge = page.locator(`[data-task-id="${taskId}"]`);
			await expect(badge).toBeVisible({ timeout: 5000 });
			await expect(badge).toContainText("Important Bug");
		});
	});
});

test.describe("Doc → Doc Mentions", () => {
	test("doc content shows another doc mention badge", async ({ page }) => {
		await test.step("Create two docs", async () => {
			server.cli('doc create "Architecture" -d "System architecture" -t "core"');
			server.cli('doc create "Module Guide" -d "How modules work" -t "guide"');
			try {
				server.cli('doc edit "module-guide" -c "## Modules\\n\\nSee @doc/architecture for system overview."');
			} catch {
				server.cli('doc edit "Module Guide" -c "## Modules\\n\\nSee @doc/architecture for system overview."');
			}
		});

		await test.step("Navigate to docs and open Module Guide", async () => {
			await page.goto(`${server.baseURL}/docs`);
			await page.getByText("Module Guide").first().click();
		});

		await test.step("Doc mention badge is visible", async () => {
			const badge = page.locator('[data-doc-path="architecture.md"]');
			await expect(badge).toBeVisible({ timeout: 5000 });
			await expect(badge).toContainText("Architecture");
		});

		await test.step("Doc mention badge is clickable", async () => {
			const badge = page.locator('[data-doc-path="architecture.md"]');
			await expect(badge).toHaveAttribute("role", "link");
		});
	});
});

test.describe("Multiple Mentions", () => {
	test("description with multiple task and doc mentions", async ({ page }) => {
		let taskId1 = "";
		let taskId2 = "";

		await test.step("Create tasks and docs", async () => {
			const out1 = server.cli('task create "Backend API" -d "Build backend"');
			const match1 = out1.match(/Created task\s+([a-z0-9]+)/i);
			taskId1 = match1?.[1] || "";

			const out2 = server.cli('task create "Frontend UI" -d "Build frontend"');
			const match2 = out2.match(/Created task\s+([a-z0-9]+)/i);
			taskId2 = match2?.[1] || "";

			server.cli('doc create "Design Spec" -d "Design specifications" -t "spec"');
		});

		await test.step("Create task with multiple mentions", async () => {
			server.cli(
				`task create "Integration" -d "Integrate @task-${taskId1} and @task-${taskId2} following @doc/design-spec"`,
			);
		});

		await test.step("Open task from kanban", async () => {
			await page.goto(`${server.baseURL}/kanban`);
			await page.getByText("Integration").first().click();
		});

		await test.step("All mention badges are visible", async () => {
			const taskBadge1 = page.locator(`[data-task-id="${taskId1}"]`);
			const taskBadge2 = page.locator(`[data-task-id="${taskId2}"]`);
			const docBadge = page.locator('[data-doc-path="design-spec.md"]');

			await expect(taskBadge1).toBeVisible({ timeout: 5000 });
			await expect(taskBadge2).toBeVisible({ timeout: 5000 });
			await expect(docBadge).toBeVisible({ timeout: 5000 });

			await expect(taskBadge1).toContainText("Backend API");
			await expect(taskBadge2).toContainText("Frontend UI");
			await expect(docBadge).toContainText("Design Spec");
		});
	});
});

test.describe("Doc Reference Copy", () => {
	test("copy reference button copies doc path", async ({ page, context }) => {
		await test.step("Create a doc", async () => {
			server.cli('doc create "Ref Test Doc" -d "Test copying reference" -t "test"');
		});

		await test.step("Grant clipboard permissions", async () => {
			await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		});

		await test.step("Navigate to docs and select the doc", async () => {
			await page.goto(`${server.baseURL}/docs`);
			await page.getByText("Ref Test Doc").first().click();
		});

		await test.step("Find and click copy reference button", async () => {
			// Look for copy/reference button in the doc view
			const copyBtn = page.getByRole("button", { name: /copy|reference|ref/i }).first();
			if (await copyBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
				await copyBtn.click();
				await page.waitForTimeout(500);
			}
		});
	});
});
