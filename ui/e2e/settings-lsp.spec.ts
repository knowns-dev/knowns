import { test, expect, type Page } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(() => {
	server?.cleanup();
});

const openSearchCode = async (page: Page) => {
	await page.goto(`${server.baseURL}/config`);
	await page.getByRole("button", { name: "Search & Code", exact: true }).click();
};

// The server is shared by this file, so earlier tests leave languages behind: count rows, not "any row".
const languageRows = (page: Page) => page.locator('[data-testid^="lsp-language-"]');

// The real-server tests target bash explicitly: it is the language whose server (bash-language-server)
// is installed on the e2e machines. Where it is missing the add is refused and the test skips.
const BASH = "bash";
const bashRow = (page: Page) => page.getByTestId(`lsp-language-${BASH}`);

/**
 * Makes sure the bash row exists, adding it when needed. Returns false when the machine has no usable
 * bash-language-server: the add is refused with an error toast, which is the right product behaviour.
 */
const ensureBash = async (page: Page): Promise<boolean> => {
	if (await bashRow(page).isVisible()) return true;
	await page.getByRole("button", { name: "Add", exact: true }).click();
	const option = page.getByRole("group", { name: "Available languages" }).getByRole("button", { name: /bash/i });
	await expect(option).toBeVisible();
	await option.click();
	let outcome = "pending";
	await expect
		.poll(
			async () => {
				if (await bashRow(page).isVisible()) return (outcome = "added");
				const refused = await page.getByText(/unavailable|not found|Failed to add language/i).first().isVisible().catch(() => false);
				return (outcome = refused ? "refused" : "pending");
			},
			{ timeout: 20000 },
		)
		.not.toBe("pending");
	return outcome === "added";
};

/** Each real-server test leaves the project as it found it: no bash row. */
const cleanUpBash = async (page: Page) => {
	await page.goto(`${server.baseURL}/config`);
	await page.getByRole("button", { name: "Search & Code", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Language Server Protocol" })).toBeVisible();
	if (await bashRow(page).isVisible()) {
		await bashRow(page).getByRole("button", { name: /^Remove / }).click();
		await expect(bashRow(page)).toHaveCount(0, { timeout: 15000 });
	}
};

test.describe("Settings: LSP (Search & Code)", () => {
	test("shows the Language Server Protocol section", async ({ page }) => {
		await openSearchCode(page);
		await expect(page.getByRole("heading", { name: "Language Server Protocol" })).toBeVisible();
	});

	test("shows the LSP enable switch", async ({ page }) => {
		await openSearchCode(page);
		await expect(page.getByRole("switch", { name: "Enable language servers" })).toBeVisible();
	});

	test("shows the Add button", async ({ page }) => {
		await openSearchCode(page);
		await expect(page.getByRole("button", { name: "Add", exact: true })).toBeVisible();
	});

	test("Add dropdown lists the available languages", async ({ page }) => {
		await openSearchCode(page);
		const add = page.getByRole("button", { name: "Add", exact: true });
		await add.click();
		await expect(add).toHaveAttribute("aria-expanded", "true");
		const dropdown = page.getByRole("group", { name: "Available languages" });
		await expect(dropdown).toBeVisible();
		await expect(dropdown.getByRole("button").first()).toBeVisible();
	});

	test.describe("with a real language server", () => {
		test.afterEach(async ({ page }) => {
			await cleanUpBash(page);
		});

		test("adds a language as one row and keeps debug tools behind Details", async ({ page }) => {
			await openSearchCode(page);
			test.skip(!(await ensureBash(page)), "bash-language-server is not installed on this machine");
			const row = bashRow(page);
			await expect(row.getByRole("button", { name: "Restart" })).toBeVisible();
			// Install, Logs and Trace live behind Details, not on the row.
			await expect(row.getByRole("button", { name: "Logs" })).toHaveCount(0);
			await row.getByRole("button", { name: "Details" }).click();
			await expect(row.getByRole("button", { name: "Logs" })).toBeVisible();
			await expect(row.getByRole("button", { name: "Trace" }).first()).toBeVisible();
		});

		test("toggles a language off and on", async ({ page }) => {
			await openSearchCode(page);
			test.skip(!(await ensureBash(page)), "bash-language-server is not installed on this machine");
			const toggle = bashRow(page).getByRole("switch").first();
			await expect(toggle).toHaveAttribute("aria-checked", "true");
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-checked", "false", { timeout: 15000 });
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 15000 });
		});

		test("removes a language from the list", async ({ page }) => {
			await openSearchCode(page);
			test.skip(!(await ensureBash(page)), "bash-language-server is not installed on this machine");
			await bashRow(page).getByRole("button", { name: /^Remove / }).click();
			await expect(bashRow(page)).toHaveCount(0, { timeout: 15000 });
		});
	});
});

// The same row UI against fake language servers, so add, toggle, remove and Details are exercised on
// machines (like CI or the Windows VM) where no real language server is installed.
type FakeLsp = { enabled?: boolean; binary?: string };

async function mockLsp(page: Page, configured: Record<string, FakeLsp>) {
	let lsp: { enabled: boolean; languages: Record<string, FakeLsp> } = { enabled: true, languages: { ...configured } };
	let base: Record<string, unknown> = {};
	const patches: Array<Record<string, unknown>> = [];
	const calls: string[] = [];

	const info = (id: string, name: string) => ({
		id,
		name,
		binary: `${id}-ls`,
		installed: true,
		running: false,
		status: "stopped",
		installState: "installed",
		readinessState: "unknown",
		installHint: `npm install -g ${id}-ls`,
		capabilities: ["definition", "references"],
	});

	await page.route("**/api/config", async (route) => {
		const method = route.request().method();
		if (method === "GET") {
			const response = await route.fetch();
			const body = await response.json();
			base = body.config || {};
			await route.fulfill({ response, json: { ...body, config: { ...base, lsp } } });
		} else if (method === "PATCH") {
			const patch = route.request().postDataJSON() as Record<string, unknown>;
			patches.push(patch);
			if (patch.lsp) lsp = patch.lsp as typeof lsp;
			await route.fulfill({ json: { config: { ...base, lsp } } });
		} else {
			await route.continue();
		}
	});

	await page.route(/\/api\/lsp\/languages(\/[^/]+)?$/, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
		if (request.method() === "GET") {
			await route.fulfill({ json: { languages: [info("alpha", "Alpha Lang"), info("beta", "Beta Lang")] } });
			return;
		}
		calls.push(`${request.method()} ${url.pathname.endsWith("/languages") ? "(add)" : id}`);
		await route.fulfill({ json: { language: id, status: "ok", action: request.method().toLowerCase() } });
	});

	return { patches, calls };
}

const lastPatchedLanguages = (patches: Array<Record<string, unknown>>) => {
	const last = [...patches].reverse().find((p) => p.lsp) as { lsp: { languages: Record<string, FakeLsp> } } | undefined;
	return last?.lsp.languages;
};

test.describe("Settings: LSP rows (mocked language servers)", () => {
	test("adds a language as a row and keeps the others in the saved lsp", async ({ page }) => {
		const { patches } = await mockLsp(page, { alpha: { enabled: true, binary: "alpha-ls" } });
		await openSearchCode(page);
		await expect(languageRows(page)).toHaveCount(1);

		await page.getByRole("button", { name: "Add", exact: true }).click();
		const offered = page.getByRole("group", { name: "Available languages" });
		await expect(offered.getByRole("button", { name: /Alpha Lang/ })).toHaveCount(0);
		await offered.getByRole("button", { name: /Beta Lang/ }).click();

		await expect(languageRows(page)).toHaveCount(2);
		await expect.poll(() => lastPatchedLanguages(patches) !== undefined).toBe(true);
		const saved = lastPatchedLanguages(patches)!;
		expect(Object.keys(saved).sort()).toEqual(["alpha", "beta"]);
		expect(saved.alpha).toEqual({ enabled: true, binary: "alpha-ls" });
		expect(saved.beta.enabled).toBe(true);
	});

	test("toggling a language saves the full lsp with every language kept", async ({ page }) => {
		const { patches, calls } = await mockLsp(page, {
			alpha: { enabled: true, binary: "alpha-ls" },
			beta: { enabled: true, binary: "beta-ls" },
		});
		await openSearchCode(page);
		const toggle = page.getByRole("switch", { name: "Enable Alpha Lang" });
		await expect(toggle).toHaveAttribute("aria-checked", "true");
		await toggle.click();

		await expect.poll(() => lastPatchedLanguages(patches) !== undefined).toBe(true);
		const saved = lastPatchedLanguages(patches)!;
		expect(Object.keys(saved).sort()).toEqual(["alpha", "beta"]);
		expect(saved.alpha).toEqual({ enabled: false, binary: "alpha-ls" });
		expect(saved.beta).toEqual({ enabled: true, binary: "beta-ls" });
		expect(calls).toContain("PUT alpha");
		await expect(toggle).toHaveAttribute("aria-checked", "false");
	});

	test("removing a language drops only that row from the saved lsp", async ({ page }) => {
		const { patches, calls } = await mockLsp(page, {
			alpha: { enabled: true, binary: "alpha-ls" },
			beta: { enabled: true, binary: "beta-ls" },
		});
		await openSearchCode(page);
		await expect(languageRows(page)).toHaveCount(2);
		await page.getByRole("button", { name: "Remove Alpha Lang" }).click();

		await expect(languageRows(page)).toHaveCount(1);
		await expect(page.getByTestId("lsp-language-beta")).toBeVisible();
		await expect.poll(() => lastPatchedLanguages(patches) !== undefined).toBe(true);
		expect(lastPatchedLanguages(patches)).toEqual({ beta: { enabled: true, binary: "beta-ls" } });
		expect(calls).toContain("DELETE alpha");
	});

	test("Details holds the debug tools, the row does not", async ({ page }) => {
		await mockLsp(page, { alpha: { enabled: true, binary: "alpha-ls" } });
		await openSearchCode(page);
		const row = page.getByTestId("lsp-language-alpha");
		await expect(row.getByRole("button", { name: "Restart" })).toBeVisible();
		for (const tool of ["Install", "Update", "Cleanup", "Logs", "Trace"]) {
			await expect(row.getByRole("button", { name: tool, exact: true })).toHaveCount(0);
		}

		const details = row.getByRole("button", { name: "Details" });
		await expect(details).toHaveAttribute("aria-expanded", "false");
		await details.click();
		await expect(details).toHaveAttribute("aria-expanded", "true");
		for (const tool of ["Install", "Update", "Cleanup", "Logs", "Trace"]) {
			await expect(row.getByRole("button", { name: tool, exact: true })).toBeVisible();
		}
		await expect(row.getByText("Backend", { exact: true })).toBeVisible();
		await expect(row.getByText("alpha-ls").first()).toBeVisible();
	});
});
