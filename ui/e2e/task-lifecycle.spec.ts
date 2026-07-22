import { test, expect, type Page } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

function createTask(title: string, extra = ""): string {
	const output = server.cli(`task create "${title}" ${extra}`);
	return output.match(/Created task\s+([a-z0-9]+)/i)?.[1] || "";
}

async function selectLifecycle(page: Page, value: string) {
	await page.locator("#task-lifecycle-filter").selectOption(value);
}

function taskDTO(id: string, title: string, lifecycleState: "active" | "done" | "archived") {
	const now = new Date().toISOString();
	return {
		id,
		title,
		description: "",
		status: lifecycleState === "active" ? "todo" : "done",
		priority: "medium",
		labels: [],
		subtasks: [],
		createdAt: now,
		updatedAt: now,
		completedAt: lifecycleState === "active" ? undefined : now,
		archivedAt: lifecycleState === "archived" ? now : undefined,
		archived: lifecycleState === "archived",
		lifecycleState,
		acceptanceCriteria: [],
		timeSpent: 0,
		timeEntries: [],
	};
}

test.describe("Task lifecycle settings", () => {
	test("shows backend defaults, autosaves valid values, and surfaces backend validation", async ({ page }) => {
		const beforeConfig = await page.request.get(`${server.baseURL}/api/config`).then((response) => response.json());
		await page.goto(`${server.baseURL}/config`);
		await page.getByRole("button", { name: "Task lifecycle" }).click();

		await expect(page.getByTestId("task-lifecycle-settings")).toBeVisible();
		await expect(page.getByLabel("Exclude done Tasks from default AI retrieval")).toBeChecked();
		await expect(page.getByLabel("Enable automatic Task archival")).toBeChecked();
		await expect(page.getByLabel("Archive completed Tasks after")).toHaveValue("30d");
		await expect(page.getByTestId("task-purge-disabled")).toContainText("Disabled");

		const validSave = page.waitForResponse((response) =>
			response.url().endsWith("/api/config") && response.request().method() === "PATCH" && response.status() === 200,
		);
		await page.getByLabel("Archive completed Tasks after").fill("45d");
		const validResponse = await validSave;
		expect(validResponse.request().postDataJSON()).toEqual({ taskLifecycle: { archiveAfter: "45d" } });
		const config = await page.request.get(`${server.baseURL}/api/config`).then((response) => response.json());
		expect(config.config.taskLifecycle.archiveAfter).toBe("45d");
		expect(config.config.name).toBe(beforeConfig.config.name);

		const invalidSave = page.waitForResponse((response) =>
			response.url().endsWith("/api/config") && response.request().method() === "PATCH" && response.status() === 400,
		);
		await page.getByLabel("Archive completed Tasks after").fill("not-a-duration");
		await invalidSave;
		await expect(page.getByText(/taskLifecycle\.archiveAfter|invalid duration/i).first()).toBeVisible();
		await expect(page.getByLabel("Archive completed Tasks after")).toHaveValue("45d");

		const externalUpdate = await page.request.patch(`${server.baseURL}/api/config`, {
			data: { taskLifecycle: { autoArchive: false } },
		});
		expect(externalUpdate.ok()).toBeTruthy();
		const siblingSafeSave = page.waitForResponse((response) =>
			response.url().endsWith("/api/config") && response.request().method() === "PATCH" && response.status() === 200,
		);
		// This tab still has the old effective autoArchive=true value. Its field patch must not resend that sibling.
		await page.getByLabel("Archive completed Tasks after").fill("46d");
		const siblingSafeResponse = await siblingSafeSave;
		expect(siblingSafeResponse.request().postDataJSON()).toEqual({ taskLifecycle: { archiveAfter: "46d" } });
		const merged = await page.request.get(`${server.baseURL}/api/config`).then((response) => response.json());
		expect(merged.config.taskLifecycle).toMatchObject({ autoArchive: false, archiveAfter: "46d", purgeAfter: null });
		await expect(page.getByLabel("Enable automatic Task archival")).not.toBeChecked();
		await page.request.patch(`${server.baseURL}/api/config`, { data: { taskLifecycle: { autoArchive: true } } });
	});

	test("serializes autosaves so an older response cannot overwrite a newer draft", async ({ page }) => {
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
		const patches: Array<Record<string, unknown>> = [];
		await page.route("**/api/config", async (route) => {
			if (route.request().method() !== "PATCH") return route.continue();
			patches.push(route.request().postDataJSON() as Record<string, unknown>);
			if (patches.length === 1) await firstGate;
			const response = await route.fetch();
			await route.fulfill({ response });
		});

		await page.goto(`${server.baseURL}/config`);
		await page.getByRole("button", { name: "Task lifecycle" }).click();
		const archiveAfter = page.getByLabel("Archive completed Tasks after");
		await archiveAfter.fill("51d");
		await expect.poll(() => patches.length).toBe(1);
		await archiveAfter.fill("52d");
		await page.waitForTimeout(750);
		expect(patches).toHaveLength(1);
		await expect(archiveAfter).toHaveValue("52d");
		releaseFirst();
		await expect.poll(() => patches.length).toBe(2);
		await expect(archiveAfter).toHaveValue("52d");
		await expect.poll(async () => {
			const response = await page.request.get(`${server.baseURL}/api/config`).then((result) => result.json());
			return response.config.taskLifecycle.archiveAfter;
		}).toBe("52d");
	});
});

test.describe("Task lifecycle workflows", () => {
	test("keeps default Task fetch current-only and ignores a stale historical response", async ({ page }) => {
		const active = taskDTO("current1", "Current-only Task", "active");
		const archived = taskDTO("archive1", "Archived must not leak", "archived");
		let releaseHistorical!: () => void;
		let markHistoricalStarted!: () => void;
		const historicalGate = new Promise<void>((resolve) => { releaseHistorical = resolve; });
		const historicalStarted = new Promise<void>((resolve) => { markHistoricalStarted = resolve; });
		const listRequests: string[] = [];
		await page.route("**/api/tasks**", async (route) => {
			const url = new URL(route.request().url());
			if (route.request().method() !== "GET" || url.pathname !== "/api/tasks") return route.continue();
			listRequests.push(url.search);
			if (url.searchParams.get("includeHistorical") === "true") {
				markHistoricalStarted();
				await historicalGate;
				await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([active, archived]) }).catch(() => {});
				return;
			}
			// Even a buggy current endpoint response is defensively stripped of archived content.
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([active, archived]) });
		});

		await page.goto(`${server.baseURL}/tasks`);
		await expect(page.getByText(active.title)).toBeVisible();
		await expect(page.getByText(archived.title)).toHaveCount(0);
		expect(listRequests).toEqual([""]);
		await selectLifecycle(page, "archived");
		await historicalStarted;
		await selectLifecycle(page, "current");
		releaseHistorical();
		await page.waitForTimeout(100);
		await expect(page.getByText(active.title)).toBeVisible();
		await expect(page.getByText(archived.title)).toHaveCount(0);
		expect(listRequests.filter((query) => query.includes("includeHistorical=true"))).toHaveLength(1);
	});

	test("refreshes an unchanged Archived view on lifecycle events without applying stale history", async ({ page }) => {
		const taskID = createTask("Lifecycle Live Historical", "--status done");
		let releaseFirst!: () => void;
		let markFirstStarted!: () => void;
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
		const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
		let historicalCalls = 0;
		await page.route("**/api/tasks**", async (route) => {
			const url = new URL(route.request().url());
			if (route.request().method() !== "GET" || url.pathname !== "/api/tasks" || url.searchParams.get("includeHistorical") !== "true") {
				return route.continue();
			}
			historicalCalls += 1;
			if (historicalCalls === 1) {
				const staleResponse = await route.fetch();
				markFirstStarted();
				await firstGate;
				await route.fulfill({ response: staleResponse }).catch(() => {});
				return;
			}
			const response = await route.fetch();
			await route.fulfill({ response });
		});

		await page.goto(`${server.baseURL}/tasks`);
		await selectLifecycle(page, "archived");
		await firstStarted;
		const archiveResponse = await page.request.post(`${server.baseURL}/api/tasks/${taskID}/archive`, {
			data: { taskId: taskID, execute: true },
		});
		expect(archiveResponse.ok()).toBeTruthy();
		await expect.poll(() => historicalCalls).toBeGreaterThanOrEqual(2);
		await expect(page.getByText("Lifecycle Live Historical").first()).toBeVisible();
		releaseFirst();
		await page.waitForTimeout(100);
		await expect(page.locator("#task-lifecycle-filter")).toHaveValue("archived");
		await expect(page.getByText("Lifecycle Live Historical").first()).toBeVisible();

		const unarchiveResponse = await page.request.post(`${server.baseURL}/api/tasks/${taskID}/unarchive`, {
			data: { taskId: taskID, execute: true },
		});
		expect(unarchiveResponse.ok()).toBeTruthy();
		await expect.poll(() => historicalCalls).toBeGreaterThanOrEqual(3);
		await expect(page.getByText("Lifecycle Live Historical")).toHaveCount(0);
		await expect(page.locator("#task-lifecycle-filter")).toHaveValue("archived");
	});

	test("renders active, done, and archived states and keeps batch archive preview read-only until confirmation", async ({ page }) => {
		const activeID = createTask("Lifecycle Active");
		const doneID = createTask("Lifecycle Done", '--status done --plan "Review @doc/guides/lifecycle before archival"');
		expect(activeID).not.toBe("");
		expect(doneID).not.toBe("");

		await page.goto(`${server.baseURL}/tasks`);
		await expect(page.getByText("Lifecycle Active").first()).toBeVisible();
		await expect(page.getByText("Lifecycle Done").first()).toBeVisible();
		await expect(page.getByTestId("task-lifecycle-state").filter({ hasText: "Active" }).first()).toBeVisible();
		await expect(page.getByTestId("task-lifecycle-state").filter({ hasText: "Done" }).first()).toBeVisible();

		await page.goto(`${server.baseURL}/kanban`);
		await page.getByRole("button", { name: /^Archive$/ }).click();
		await page.getByRole("menuitem", { name: /Done before now/ }).click();
		const dialog = page.getByTestId("task-lifecycle-dialog");
		await expect(dialog).toBeVisible();
		await expect(page.getByTestId(`lifecycle-item-${activeID}`)).toContainText("Task is not done");
		await expect(page.getByTestId(`lifecycle-item-${doneID}`)).toContainText("Eligible");
		await expect(page.getByTestId(`lifecycle-item-${doneID}`).getByTestId("lifecycle-warning")).toContainText("Review the Task Plan and Notes");

		await dialog.getByRole("button", { name: "Cancel" }).click();
		const before = await page.request.get(`${server.baseURL}/api/tasks/${doneID}`).then((response) => response.json());
		expect(before.lifecycleState).toBe("done");

		await page.getByRole("button", { name: /^Archive$/ }).click();
		await page.getByRole("menuitem", { name: /Done before now/ }).click();
		await expect(page.getByTestId(`lifecycle-item-${doneID}`)).toBeVisible();
		const lateDoneID = createTask("Lifecycle Done After Preview", "--status done");
		await dialog.getByTestId("lifecycle-confirm").click();
		await expect(dialog.getByTestId("lifecycle-progress")).toContainText("Changed 1");
		await expect(dialog.getByTestId("lifecycle-event")).toBeVisible();

		await dialog.getByRole("button", { name: "Cancel" }).click();
		const lateDone = await page.request.get(`${server.baseURL}/api/tasks/${lateDoneID}`).then((response) => response.json());
		expect(lateDone.lifecycleState).toBe("done");
		await page.goto(`${server.baseURL}/tasks`);
		await selectLifecycle(page, "archived");
		await expect(page.getByText("Lifecycle Done").first()).toBeVisible();
		await expect(page.getByTestId("task-lifecycle-state").filter({ hasText: "Archived" }).first()).toBeVisible();
		await page.setViewportSize({ width: 640, height: 900 });
		await page.getByText("Lifecycle Done").first().click();
		const lifecycleSummary = page.getByLabel("Task lifecycle");
		await expect(lifecycleSummary.getByTestId("task-lifecycle-state")).toContainText("Archived");
		await expect(lifecycleSummary.getByTestId("task-lifecycle-timestamps")).toContainText("Archived");
		await expect(page.getByRole("button", { name: "Restore Task" }).first()).toBeVisible();
		await page.getByTitle("Close").click();
		await page.setViewportSize({ width: 1280, height: 900 });

		await page.getByRole("button", { name: /Restore archived/ }).click();
		await expect(dialog).toBeVisible();
		const lateArchivedID = createTask("Lifecycle Archived After Restore Preview", "--status done");
		server.cli(`task archive ${lateArchivedID} --yes`);
		await dialog.getByTestId("lifecycle-confirm").click();
		await expect(dialog.getByTestId("lifecycle-progress")).toContainText("Changed 1");
		await expect.poll(async () => {
			const task = await page.request.get(`${server.baseURL}/api/tasks/${doneID}`).then((response) => response.json());
			return task.lifecycleState;
		}).toBe("active");
		const lateArchived = await page.request.get(`${server.baseURL}/api/tasks/${lateArchivedID}`).then((response) => response.json());
		expect(lateArchived.lifecycleState).toBe("archived");
	});

	test("renders stable skips and warnings and supports retry after a partial execution response", async ({ page }) => {
		const doneID = createTask("Lifecycle Partial Retry", "--status done");
		let executeCalls = 0;
		const executeBodies: Array<{ ids?: string[]; execute?: boolean }> = [];
		const completedAt = new Date(Date.now() - 60_000).toISOString();
		const deadline = new Date(Date.now() - 30_000).toISOString();
		const base = {
			operation: "batch_archive",
			processed: 2,
			changed: 0,
			failedTaskId: "",
			items: [
				{
					taskId: doneID,
					operation: "batch_archive",
					changed: false,
					eligible: true,
					before: "done",
					after: "done",
					reasons: [],
					completedAt,
					deadline,
					warnings: [{ code: "durable_knowledge_review", message: "Review durable notes", references: ["@doc/guides/retry"] }],
				},
				{
					taskId: "blocked1",
					operation: "batch_archive",
					changed: false,
					eligible: false,
					before: "active",
					after: "active",
					reasons: [{ code: "active_timer", message: "Task has an active timer" }],
				},
			],
		};

		await page.route("**/api/tasks/batch-archive", async (route) => {
			const body = route.request().postDataJSON() as { ids?: string[]; execute?: boolean };
			if (!body.execute) {
				await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...base, execute: false, completed: true }) });
				return;
			}
			executeCalls += 1;
			executeBodies.push(body);
			if (executeCalls === 1) {
				await route.fulfill({
					status: 500,
					contentType: "application/json",
					body: JSON.stringify({
						...base,
						execute: true,
						completed: true,
						processed: 2,
						changed: 1,
						failedTaskId: doneID,
						items: [
							{
								...base.items[0],
								changed: true,
								after: "archived",
								archivedAt: new Date().toISOString(),
								reasons: [{ code: "operation_failed", message: "event checkpoint repair is pending" }],
								event: { id: "stable-event-1", type: "archive", taskId: doneID, at: new Date().toISOString(), from: "done", to: "archived" },
							},
							base.items[1],
						],
					}),
				});
				return;
			}
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...base, execute: true, completed: true, processed: 2 }) });
		});

		await page.goto(`${server.baseURL}/kanban`);
		await page.getByRole("button", { name: /^Archive$/ }).click();
		await page.getByRole("menuitem", { name: /Done before now/ }).click();
		const dialog = page.getByTestId("task-lifecycle-dialog");
		await expect(dialog.getByTestId("lifecycle-items").locator(":scope > li")).toHaveCount(2);
		await expect(dialog.getByTestId("lifecycle-reasons")).toContainText("Timer is still active");
		await expect(dialog.getByTestId("lifecycle-warning")).toContainText("@doc/guides/retry");
		await expect(page.getByTestId(`lifecycle-item-${doneID}`).getByTestId("lifecycle-timestamps")).toContainText("Completed");
		await expect(page.getByTestId(`lifecycle-item-${doneID}`).getByTestId("lifecycle-deadline")).toBeVisible();
		await dialog.getByTestId("lifecycle-confirm").click();
		await expect(dialog.getByTestId("lifecycle-progress")).toContainText(`Failed at #${doneID}`);
		await expect(dialog.getByTestId("lifecycle-progress")).toContainText("Repair pending");
		await expect(page.getByTestId(`lifecycle-item-${doneID}`)).toContainText("Repair pending");
		await expect(page.getByTestId(`lifecycle-item-${doneID}`).getByTestId("lifecycle-timestamps")).toContainText("Archived");
		await expect(dialog.getByRole("button", { name: "Retry remaining" })).toBeVisible();
		await dialog.getByRole("button", { name: "Retry remaining" }).click();
		await expect(dialog.getByTestId("lifecycle-progress")).toContainText("Complete");
		expect(executeCalls).toBe(2);
		expect(executeBodies[0].ids).toEqual([doneID, "blocked1"]);
		expect(executeBodies[1].ids).toEqual(executeBodies[0].ids);
		expect(new Set(executeBodies[0].ids).size).toBe(executeBodies[0].ids?.length);
	});

	test("does not let a delayed preview for Task A execute against Task B", async ({ page }) => {
		const taskA = createTask("Lifecycle Delayed Preview A", "--status done");
		const taskB = createTask("Lifecycle Delayed Preview B", "--status done");
		let releaseA!: () => void;
		let markAStarted!: () => void;
		const aGate = new Promise<void>((resolve) => { releaseA = resolve; });
		const aStarted = new Promise<void>((resolve) => { markAStarted = resolve; });
		let bExecuteCalls = 0;

		await page.route(`**/api/tasks/${taskA}/archive`, async (route) => {
			markAStarted();
			await aGate;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					operation: "archive", execute: false, completed: true, processed: 1, changed: 0,
					items: [{ taskId: taskA, operation: "archive", changed: false, eligible: true, before: "done", after: "done", reasons: [] }],
				}),
			}).catch(() => {});
		});
		await page.route(`**/api/tasks/${taskB}/archive`, async (route) => {
			const body = route.request().postDataJSON() as { taskId?: string; execute?: boolean };
			if (body.execute) bExecuteCalls += 1;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					operation: "archive", execute: body.execute === true, completed: true, processed: 1, changed: body.execute ? 1 : 0,
					items: [{ taskId: taskB, operation: "archive", changed: body.execute === true, eligible: true, before: "done", after: body.execute ? "archived" : "done", reasons: [] }],
				}),
			});
		});

		await page.goto(`${server.baseURL}/tasks/${taskA}`);
		await page.getByRole("button", { name: "Archive Task" }).first().click();
		await aStarted;
		await page.getByTestId("task-lifecycle-dialog").getByRole("button", { name: "Cancel" }).click();
		await page.goto(`${server.baseURL}/tasks/${taskB}`);
		await page.getByRole("button", { name: "Archive Task" }).first().click();
		const dialog = page.getByTestId("task-lifecycle-dialog");
		await expect(dialog).toContainText(`Archive Task #${taskB}`);
		releaseA();
		await page.waitForTimeout(100);
		await expect(dialog).toContainText(`Archive Task #${taskB}`);
		await dialog.getByTestId("lifecycle-confirm").click();
		await expect.poll(() => bExecuteCalls).toBe(1);
		expect(bExecuteCalls).toBe(1);
	});

	test("hides hard-delete without capability and keeps permission failures inside the guarded flow", async ({ page }) => {
		const taskID = createTask("Lifecycle Guarded Delete", "--status done");
		await page.goto(`${server.baseURL}/tasks/${taskID}`);
		await expect(page.getByRole("button", { name: /Permanently delete/ })).toHaveCount(0);

		await page.goto(`${server.baseURL}/config`);
		await page.getByRole("button", { name: "Advanced" }).click();
		const rawEditor = page.locator("textarea");
		const rawConfig = JSON.parse(await rawEditor.inputValue());
		expect(rawConfig.capabilities).toBeUndefined();
		rawConfig.capabilities = { taskHardDelete: true };
		rawConfig.taskLifecycle.archiveAfter = "invalid-forged-duration";
		await rawEditor.fill(JSON.stringify(rawConfig, null, 2));
		const forgedSave = page.waitForResponse((response) => response.url().endsWith("/api/config") && response.request().method() === "PATCH");
		await page.getByRole("button", { name: "Save", exact: true }).click();
		const forgedResponse = await forgedSave;
		expect(forgedResponse.status()).toBe(400);
		expect(forgedResponse.request().postDataJSON().capabilities).toBeUndefined();
		await page.goto(`${server.baseURL}/tasks/${taskID}`);
		await expect(page.getByRole("button", { name: /Permanently delete/ })).toHaveCount(0);

		await page.route("**/api/config", async (route) => {
			const response = await route.fetch();
			const json = await response.json();
			json.config.capabilities = { taskHardDelete: true };
			await route.fulfill({ response, json });
		});
		await page.route(`**/api/tasks/${taskID}/hard-delete`, async (route) => {
			await route.fulfill({
				status: 403,
				contentType: "application/json",
				body: JSON.stringify({
					operation: "hard_delete",
					execute: true,
					completed: false,
					processed: 1,
					changed: 0,
					items: [{ taskId: taskID, operation: "hard_delete", changed: false, eligible: false, before: "done", after: "done", reasons: [{ code: "permission_required", message: "Hard-delete permission is required" }] }],
				}),
			});
		});

		await page.reload();
		await page.getByRole("button", { name: /Permanently delete/ }).first().click();
		const guard = page.getByTestId("task-hard-delete-dialog");
		await expect(guard.getByRole("button", { name: "Permanently delete" })).toBeDisabled();
		await guard.getByLabel("Reason").fill("Approved E2E cleanup");
		await guard.getByLabel(`Type ${taskID} to confirm`).fill(taskID);
		await guard.getByRole("button", { name: "Permanently delete" }).click();
		await expect(guard.getByRole("alert")).toContainText("Permission required");
		const retained = await page.request.get(`${server.baseURL}/api/tasks/${taskID}`);
		expect(retained.ok()).toBeTruthy();
	});
});
