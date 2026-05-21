/**
 * E2E test helpers — start/stop knowns server with isolated project
 */

import { execSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Find a genuinely available port by binding to port 0 and reading the OS-assigned port */
function findPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			if (addr && typeof addr === "object") {
				const port = addr.port;
				srv.close(() => resolve(port));
			} else {
				srv.close(() => reject(new Error("Failed to get port from server address")));
			}
		});
		srv.on("error", reject);
	});
}

/** Wait for HTTP server to be ready */
async function waitForServer(
	url: string,
	timeoutMs = 30000,
): Promise<void> {
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

export interface TestServer {
	/** Base URL of the running server */
	baseURL: string;
	/** Port the server is listening on */
	port: number;
	/** Path to the temporary project directory */
	projectDir: string;
	/** Run a CLI command against the test project */
	cli: (args: string) => string;
	/** Stop the server and clean up */
	cleanup: () => void;
}

/**
 * Start a knowns server with an isolated temporary project.
 * Returns helpers for interacting with the server.
 */
export async function startServer(): Promise<TestServer> {
	// Verify binary exists
	if (!existsSync(BINARY)) {
		throw new Error(
			`Binary not found at ${BINARY}. Run 'make build' first.`,
		);
	}

	// Create isolated project directory
	const projectDir = mkdtempSync(join(tmpdir(), "knowns-e2e-"));

	// Initialize git + knowns project
	execSync("git init", { cwd: projectDir, stdio: "ignore" });
	execSync("git config user.email test@test.com", {
		cwd: projectDir,
		stdio: "ignore",
	});
	execSync("git config user.name Test", {
		cwd: projectDir,
		stdio: "ignore",
	});
	execSync(`${BINARY} init "E2E Test Project" --no-wizard --no-open`, {
		cwd: projectDir,
		stdio: "ignore",
	});

	// Find available port and start server
	const port = await findPort();
	const serverProcess: ChildProcess = spawn(
		BINARY,
		["browser", "--port", String(port), "--no-open"],
		{
			cwd: projectDir,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1" },
		},
	);

	// Collect stderr for diagnostics if startup fails
	let serverStderr = "";
	serverProcess.stderr?.on("data", (chunk: Buffer) => {
		serverStderr += chunk.toString();
	});

	const baseURL = `http://localhost:${port}`;

	// Wait for server to be ready
	try {
		await waitForServer(baseURL);
	} catch (err) {
		serverProcess.kill("SIGTERM");
		rmSync(projectDir, { recursive: true, force: true });
		const detail = serverStderr ? `\nServer stderr:\n${serverStderr}` : "";
		throw new Error(
			`Server not ready at ${baseURL} after timeout.${detail}`,
		);
	}

	const cli = (args: string): string => {
		if (isWindows) {
			// On Windows, cmd.exe mangles nested double quotes.
			// Use shell: "bash" (Git Bash available on CI) for consistent quoting.
			return execSync(`${BINARY} ${args}`, {
				cwd: projectDir,
				encoding: "utf-8",
				timeout: 10000,
				shell: "bash",
				env: { ...process.env, NO_COLOR: "1" },
			}).trim();
		}
		return execSync(`${BINARY} ${args}`, {
			cwd: projectDir,
			encoding: "utf-8",
			timeout: 10000,
			env: { ...process.env, NO_COLOR: "1" },
		}).trim();
	};

	const cleanup = () => {
		serverProcess.kill("SIGTERM");
		// Wait for process to fully exit before removing files
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
			// EBUSY on Windows — best effort cleanup
		}
	};

	return { baseURL, port, projectDir, cli, cleanup };
}
