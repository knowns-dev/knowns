// KN-CM6YBW: the Runtime page does not poll fast. The daemon announces a status change (SSE
// runtime:status) and the page shows it within 2 s; a hidden tab makes no /api/runtime/ps requests.
// Unlike the other specs this one needs the daemon-served UI (`knowns browser` hands off), because
// the status events come from the daemon's loop; a --foreground server has no loop to announce them.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";
const BINARY = process.env.TEST_BINARY
	? resolve(process.cwd(), process.env.TEST_BINARY)
	: resolve(here, isWindows ? "../../bin/knowns.exe" : "../../bin/knowns");
const PROXY = join(dirname(BINARY), isWindows ? "knowns-proxy.exe" : "knowns-proxy");

const base = mkdtempSync(join(tmpdir(), "knowns-e2e-live-"));
const home = join(base, "home");
const project = join(base, "project");
const runtime = join(base, "runtime");
for (const d of [home, project, runtime]) mkdirSync(d);
const env = {
	...process.env,
	HOME: home,
	USERPROFILE: home,
	KNOWNS_RUNTIME_ROOT: runtime,
	NO_COLOR: "1",
	NO_UPDATE_CHECK: "1",
	KNOWN_LSP_AUTO_INSTALL: "0",
	KNOWN_LSP_DAEMON: "0",
	KNOWNS_LSP_DAEMON: "0",
	KNOWNS_PROXY_KNOWNS_BIN: BINARY,
} as Record<string, string>;
delete env.KNOWNS_MCP_PROXY;
let port = 0;
const sessions: ChildProcess[] = [];

const freePort = () =>
	new Promise<number>((res, rej) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const a = s.address();
			s.close(() => (a && typeof a === "object" ? res(a.port) : rej(new Error("no port"))));
		});
	});
const run = (args: string[]) =>
	execFileSync(BINARY, args, { cwd: project, env, encoding: "utf-8", timeout: 60_000 });

test.skip(!existsSync(BINARY) || !existsSync(PROXY), "needs the built knowns and knowns-proxy");

test.beforeAll(async () => {
	execFileSync("git", ["init", "-q"], { cwd: project });
	run(["init", "E2E Live", "--no-wizard", "--no-open"]);
	port = await freePort();
	// The launcher hands the UI to the daemon and exits.
	run(["browser", "--port", String(port), "--no-open"]);
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error("the daemon did not serve the UI");
});

test.afterAll(() => {
	for (const s of sessions) s.kill();
	try {
		run(["browser", "--stop", "--port", String(port)]);
	} catch {}
	rmSync(base, { recursive: true, force: true });
});

function openSession(): ChildProcess {
	const p = spawn(PROXY, ["mcp", "--stdio"], { cwd: project, env, stdio: ["pipe", "ignore", "ignore"] });
	p.stdin?.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } })}\n`,
	);
	sessions.push(p);
	return p;
}

const clientsCount = async (page: import("@playwright/test").Page): Promise<number> => {
	const text = (await page.getByRole("tab", { name: /Clients/ }).innerText()).replace(/\s+/g, " ");
	const m = /(\d+)\s*$/.exec(text) ?? /Clients\s*(\d+)/.exec(text);
	return m ? Number(m[1]) : Number.NaN;
};

test("a session opening shows on the Runtime page within 2 s, without a fast poll", async ({ page }) => {
	const psRequests: number[] = [];
	page.on("request", (r) => {
		if (r.url().includes("/api/runtime/ps")) psRequests.push(Date.now());
	});
	await page.goto(`http://127.0.0.1:${port}/runtime`);
	await expect(page.getByRole("heading", { name: "Runtime", level: 1 })).toBeVisible();
	await expect(page.getByTestId("runtime-tile-daemon")).toContainText("Online");
	await page.getByRole("tab", { name: /Clients/ }).waitFor();
	await expect.poll(() => psRequests.length).toBeGreaterThan(0);
	const before = await clientsCount(page);

	// Wait until the page is between polls, so a change cannot be explained by a scheduled poll.
	const sinceLast = () => Date.now() - (psRequests[psRequests.length - 1] ?? 0);
	await expect.poll(sinceLast, { timeout: 15_000 }).toBeGreaterThan(3_000);
	const requestsBefore = psRequests.length;
	const t0 = Date.now();
	openSession();
	await expect
		.poll(() => clientsCount(page), { timeout: 2_000, intervals: [100, 100, 200, 200, 400] })
		.toBe(before + 1);
	const latency = Date.now() - t0;
	console.log(`status change shown after ${latency} ms`);
	expect(latency).toBeLessThan(2_000);
	// The refresh came from the SSE event (one extra request), not from a 2-3 s poll running.
	expect(psRequests.length - requestsBefore).toBeLessThanOrEqual(2);
});

test("a hidden tab makes no /api/runtime/ps requests and resumes when visible", async ({ page }) => {
	const psRequests: number[] = [];
	page.on("request", (r) => {
		if (r.url().includes("/api/runtime/ps")) psRequests.push(Date.now());
	});
	await page.goto(`http://127.0.0.1:${port}/runtime`);
	await expect(page.getByTestId("runtime-tile-daemon")).toContainText("Online");
	await expect.poll(() => psRequests.length).toBeGreaterThan(0);

	const setHidden = (hidden: boolean) =>
		page.evaluate((h) => {
			Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
			Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
			document.dispatchEvent(new Event("visibilitychange"));
		}, hidden);

	await setHidden(true);
	await page.waitForTimeout(500); // let an in-flight request finish
	const n = psRequests.length;
	await page.waitForTimeout(20_000); // longer than the 15 s visible interval
	expect(psRequests.length).toBe(n);

	await setHidden(false);
	await expect.poll(() => psRequests.length, { timeout: 3_000 }).toBeGreaterThan(n);
});
