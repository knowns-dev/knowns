import { expect, test } from "@playwright/test";
import { startServer, type TestServer } from "./helpers";

let server: TestServer;

// Through the API: markdown with code fences does not survive a shell command line.
async function putDoc(title: string, content: string, method: "POST" | "PUT" = "POST") {
	const path = title.toLowerCase().replace(/\s+/g, "-");
	const res = await fetch(`${server.baseURL}/api/docs${method === "PUT" ? `/${path}` : ""}`, {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ title, description: title, tags: ["lazy"], content }),
	});
	if (!res.ok) throw new Error(`${method} doc ${title}: ${res.status} ${await res.text()}`);
}

test.beforeAll(async () => {
	server = await startServer();
	await putDoc("Lazy Body", "## First Heading\n\nThe first paragraph of the lazy doc.\n\n```ts\nexport const answer = 42;\n```\n");
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Docs list is metadata only, the body loads on open", () => {
	test("the list asks for a summary and carries no bodies; opening a doc fetches its body once", async ({ page }) => {
		const listCalls: string[] = [];
		const bodyCalls: string[] = [];
		page.on("request", (r) => {
			const u = new URL(r.url());
			if (u.pathname === "/api/docs") listCalls.push(u.search);
			else if (u.pathname.startsWith("/api/docs/") && r.method() === "GET") bodyCalls.push(u.pathname);
		});
		const listBodies: unknown[] = [];
		page.on("response", async (res) => {
			const u = new URL(res.url());
			if (u.pathname === "/api/docs" && u.search.includes("summary=true")) listBodies.push(await res.json().catch(() => null));
		});

		await page.goto(`${server.baseURL}/docs/lazy-body`);
		await expect(page.getByText("The first paragraph of the lazy doc.")).toBeVisible();

		expect(listCalls.length).toBeGreaterThan(0);
		for (const q of listCalls) expect(q).toContain("summary=true");
		const first = listBodies[0] as { docs?: Array<{ content?: string }> } | null;
		expect(first?.docs?.length ?? 0).toBeGreaterThan(0);
		for (const d of first?.docs ?? []) expect(d.content).toBeUndefined();
		expect(bodyCalls.filter((p) => p.endsWith("lazy-body"))).toHaveLength(1);
	});

	test("a list refresh from another writer does not blank the open doc, and an edit shows up", async ({ page }) => {
		await page.goto(`${server.baseURL}/docs/lazy-body`);
		await expect(page.getByText("The first paragraph of the lazy doc.")).toBeVisible();

		await putDoc("Another Doc", "Triggers a list refresh");
		await expect(page.getByText("Another Doc").first()).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText("The first paragraph of the lazy doc.")).toBeVisible();

		await putDoc("Lazy Body", "## First Heading\n\nThe revised paragraph.\n", "PUT");
		await expect(page.getByText("The revised paragraph.")).toBeVisible({ timeout: 15_000 });
	});

	test("code in a doc renders as text first and is highlighted once highlight.js has loaded", async ({ page }) => {
		await putDoc("Code Doc", "## Code\n\n```rust\nfn main() { let x = 1; }\n```\n");
		const hl = page.waitForResponse((r) => /highlight-vendor-.*\.js$/.test(r.url()));
		await page.goto(`${server.baseURL}/docs/code-doc`);
		await expect(page.getByText("fn main()", { exact: false }).first()).toBeVisible();
		await hl; // the chunk is fetched on demand, not preloaded with the entry
		await expect(page.locator("pre code span").first()).toBeVisible();
	});
});
