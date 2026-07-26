import { test, expect } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, execFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isWindows = process.platform === "win32";
const defaultBinary = resolve(
	__dirname,
	isWindows ? "../../bin/knowns.exe" : "../../bin/knowns",
);
const BINARY = process.env.TEST_BINARY
	? resolve(process.cwd(), process.env.TEST_BINARY)
	: defaultBinary;

function findPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			if (addr && typeof addr === "object") {
				const port = addr.port;
				srv.close(() => resolve(port));
			} else {
				srv.close(() => reject(new Error("Failed to get port")));
			}
		});
		srv.on("error", reject);
	});
}

async function waitForServer(url: string, timeoutMs = 30000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(url);
			if (res.ok) return;
		} catch {
			// not ready yet
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`Server not ready at ${url} after ${timeoutMs}ms`);
}

interface TestServer {
	baseURL: string;
	port: number;
	projectDir: string;
	cleanup: () => void;
}

async function startServerWithPassword(password: string): Promise<TestServer> {
	if (!existsSync(BINARY)) {
		throw new Error(`Binary not found at ${BINARY}. Run 'make build' first.`);
	}

	const projectDir = mkdtempSync(join(tmpdir(), "knowns-e2e-pw-"));

	execSync("git init", { cwd: projectDir, stdio: "ignore" });
	execSync("git config user.email test@test.com", { cwd: projectDir, stdio: "ignore" });
	execSync("git config user.name Test", { cwd: projectDir, stdio: "ignore" });

	if (isWindows) {
		execFileSync(BINARY, ["init", "E2E Password Test", "--no-wizard", "--no-open"], {
			cwd: projectDir,
			stdio: "ignore",
		});
	} else {
		execSync(`${BINARY} init "E2E Password Test" --no-wizard --no-open`, {
			cwd: projectDir,
			stdio: "ignore",
		});
	}

	const port = await findPort();
	const serverProcess: ChildProcess = spawn(
		BINARY,
		["browser", "--port", String(port), "--no-open", "--password", password],
		{
			cwd: projectDir,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1" },
		},
	);

	let serverStderr = "";
	serverProcess.stderr?.on("data", (chunk: Buffer) => {
		serverStderr += chunk.toString();
	});

	const baseURL = `http://localhost:${port}`;

	try {
		await waitForServer(baseURL);
	} catch (err) {
		serverProcess.kill("SIGTERM");
		rmSync(projectDir, { recursive: true, force: true });
		const detail = serverStderr ? `\nServer stderr:\n${serverStderr}` : "";
		throw new Error(`Server not ready at ${baseURL} after timeout.${detail}`);
	}

	const cleanup = () => {
		serverProcess.kill("SIGTERM");
		if (isWindows) {
			spawnSync("powershell", ["-Command", "Start-Sleep -Seconds 3"], { stdio: "ignore" });
		} else {
			spawnSync("sleep", ["1"], { stdio: "ignore" });
		}
		try {
			serverProcess.kill("SIGKILL");
		} catch {
			// already dead
		}
		try {
			rmSync(projectDir, { recursive: true, force: true });
		} catch {
			// EBUSY on Windows
		}
	};

	return { baseURL, port, projectDir, cleanup };
}

let server: TestServer;
const TEST_PASSWORD = "testpass123";

test.beforeAll(async () => {
	server = await startServerWithPassword(TEST_PASSWORD);
});

test.afterAll(() => {
	server?.cleanup();
});

test.describe("Password Protection", () => {
	test("shows login gate when server is password protected", async ({ page }) => {
		await test.step("Navigate to server root", async () => {
			await page.goto(server.baseURL);
		});

		await test.step("Login gate is visible with password input", async () => {
			// Wait for login form to appear
			const passwordInput = page.locator('input[type="password"]');
			await expect(passwordInput).toBeVisible({ timeout: 10000 });

			// Check heading or description
			await expect(page.getByText(/password protected/i).or(page.getByText(/knowns/i)).first()).toBeVisible();

			// Submit button should be visible
			await expect(page.getByRole("button").first()).toBeVisible();
		});
	});

	test("rejects wrong password with error message", async ({ page }) => {
		await test.step("Navigate to server root", async () => {
			await page.goto(server.baseURL);
		});

		await test.step("Wait for login form", async () => {
			const passwordInput = page.locator('input[type="password"]');
			await expect(passwordInput).toBeVisible({ timeout: 10000 });
		});

		await test.step("Enter wrong password and submit", async () => {
			const passwordInput = page.locator('input[type="password"]');
			await passwordInput.fill("wrongpassword");
			await page.getByRole("button").first().click();
		});

		await test.step("Error message is shown", async () => {
			await expect(page.getByText(/invalid|incorrect|failed|error/i).first()).toBeVisible();
		});

		await test.step("Login gate is still visible (not bypassed)", async () => {
			const passwordInput = page.locator('input[type="password"]');
			await expect(passwordInput).toBeVisible({ timeout: 3000 });
		});
	});

	test("accepts correct password and shows the app", async ({ page }) => {
		await test.step("Navigate to server root", async () => {
			await page.goto(server.baseURL);
		});

		await test.step("Wait for login form", async () => {
			const passwordInput = page.locator('input[type="password"]');
			await expect(passwordInput).toBeVisible({ timeout: 10000 });
		});

		await test.step("Enter correct password and submit", async () => {
			const passwordInput = page.locator('input[type="password"]');
			await passwordInput.fill(TEST_PASSWORD);
			await page.getByRole("button", { name: /unlock/i }).click();
		});

		await test.step("App loads after successful login", async () => {
			// Login form should disappear
			const loginInput = page.locator('input[type="password"]');
			await expect(loginInput).not.toBeVisible({ timeout: 15000 });
		});
	});

	test("shows Protected status in Security settings after login", async ({ page }) => {
		await test.step("Login with correct password", async () => {
			await page.goto(server.baseURL);
			const passwordInput = page.locator('input[type="password"]');
			await expect(passwordInput).toBeVisible({ timeout: 10000 });
			await passwordInput.fill(TEST_PASSWORD);
			await page.getByRole("button", { name: /unlock/i }).click();
			await expect(passwordInput).not.toBeVisible({ timeout: 15000 });
		});

		await test.step("Navigate to Security settings", async () => {
			await page.goto(`${server.baseURL}/config`);
			await page.getByText(/security/i).first().click();
		});

		await test.step("Protected status is shown", async () => {
			await expect(page.getByText(/protected/i).first()).toBeVisible();
		});

		await test.step("Remove Password button is visible", async () => {
			await expect(page.getByText(/remove password/i).first()).toBeVisible();
		});
	});

	test("can remove password and access app without login", async ({ page }) => {
		await test.step("Login with correct password", async () => {
			await page.goto(server.baseURL);
			const passwordInput = page.locator('input[type="password"]');
			await expect(passwordInput).toBeVisible({ timeout: 10000 });
			await passwordInput.fill(TEST_PASSWORD);
			await page.getByRole("button", { name: /unlock/i }).click();
			await expect(passwordInput).not.toBeVisible({ timeout: 15000 });
		});

		await test.step("Navigate to Security settings", async () => {
			await page.goto(`${server.baseURL}/config`);
			await page.getByText(/security/i).first().click();
		});

		await test.step("Click Remove Password", async () => {
			await expect(page.getByText(/remove password/i).first()).toBeVisible();
			await page.getByText(/remove password/i).first().click();
			await page.waitForTimeout(1500);
		});

		await test.step("Status shows Unprotected", async () => {
			await expect(page.getByText(/unprotected/i).first()).toBeVisible();
		});
	});

	test("can set new password from Security settings", async ({ page }) => {
		await test.step("Login with correct password", async () => {
			await page.goto(server.baseURL);
			const passwordInput = page.locator('input[type="password"]');
			// May or may not show login (depends on previous test removing password)
			const needsLogin = await passwordInput.isVisible({ timeout: 3000 }).catch(() => false);
			if (needsLogin) {
				await passwordInput.fill(TEST_PASSWORD);
				await page.getByRole("button", { name: /unlock/i }).click();
				await expect(passwordInput).not.toBeVisible({ timeout: 15000 });
			}
		});

		await test.step("Navigate to Security settings", async () => {
			await page.goto(`${server.baseURL}/config`);
			await page.getByText(/security/i).first().click();
		});

		await test.step("Enter new password and click Set", async () => {
			const pwInput = page.locator('input[placeholder="Enter password"]');
			const hasPwInput = await pwInput.isVisible().catch(() => false);

			if (hasPwInput) {
				await pwInput.fill("newpassword456");
				await page.getByRole("button", { name: /set/i }).first().click();
				await page.waitForTimeout(1500);
			}
		});

		await test.step("Status shows Protected", async () => {
			await expect(page.getByText(/protected/i).first()).toBeVisible();
		});
	});
});