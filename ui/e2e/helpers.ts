/**
 * E2E test helpers — start/stop knowns server with isolated project
 */

import { execSync, execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
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
	/** Invoke one MCP tool against the test project. */
	mcp: (tool: string, args: Record<string, unknown>) => string;
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
	const homeDir = mkdtempSync(join(tmpdir(), "knowns-e2e-home-"));
	const testEnv = {
		...process.env,
		HOME: homeDir,
		USERPROFILE: homeDir,
		NO_COLOR: "1",
		NO_UPDATE_CHECK: "1",
		KNOWN_RUNTIME_INLINE: "1",
		// UI tests exercise the local fallback. Dedicated LSP fixture tests
		// cover the shared daemon and native Windows named-pipe transport.
		KNOWN_LSP_DAEMON: "0",
	};

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
	if (isWindows) {
		execFileSync(BINARY, ["init", "E2E Test Project", "--no-wizard", "--no-open"], {
			cwd: projectDir,
			stdio: "ignore",
			env: testEnv,
		});
	} else {
		execSync(`${BINARY} init "E2E Test Project" --no-wizard --no-open`, {
			cwd: projectDir,
			stdio: "ignore",
			env: testEnv,
		});
	}

	// Find available port and start server
	const port = await findPort();
	const serverProcess: ChildProcess = spawn(
		BINARY,
		["browser", "--port", String(port), "--no-open"],
		{
			cwd: projectDir,
			stdio: ["ignore", "pipe", "pipe"],
			env: testEnv,
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
		rmSync(homeDir, { recursive: true, force: true });
		const detail = serverStderr ? `\nServer stderr:\n${serverStderr}` : "";
		throw new Error(
			`Server not ready at ${baseURL} after timeout.${detail}`,
		);
	}

	const cli = (args: string): string => {
		if (isWindows) {
			// On Windows, avoid shell to prevent cmd.exe quote mangling.
			// Parse the args string into an array respecting quoted strings.
			const parsed = parseCliArgs(args);
			return execFileSync(BINARY, parsed, {
				cwd: projectDir,
				encoding: "utf-8",
				timeout: 10000,
				env: testEnv,
			}).trim();
		}
		return execSync(`${BINARY} ${args}`, {
			cwd: projectDir,
			encoding: "utf-8",
			timeout: 10000,
			env: testEnv,
		}).trim();
	};

	const mcp = (tool: string, args: Record<string, unknown>): string => {
		const input = [
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "knowns-e2e", version: "1.0.0" },
				},
			},
			{
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: tool, arguments: args },
			},
		]
			.map((message) => JSON.stringify(message))
			.join("\n");

		const output = execFileSync(BINARY, ["mcp"], {
			cwd: projectDir,
			encoding: "utf-8",
			timeout: 30000,
			env: testEnv,
			input: `${input}\n`,
		}).trim();
		const responses = output
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		const callResponse = responses.find((response) => response.id === 2);
		if (!callResponse) {
			throw new Error(`MCP tool ${tool} returned no response: ${output}`);
		}
		if (callResponse.error || callResponse.result?.isError) {
			throw new Error(
				`MCP tool ${tool} failed: ${JSON.stringify(callResponse.error ?? callResponse.result)}`,
			);
		}
		return output;
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
		try {
			rmSync(homeDir, { recursive: true, force: true });
		} catch {
			// EBUSY on Windows — best effort cleanup
		}
	};

	return { baseURL, port, projectDir, cli, mcp, cleanup };
}

/**
 * Parse a CLI args string into an array, respecting double-quoted segments.
 * e.g. 'doc edit "my doc" -c "hello world"' → ["doc", "edit", "my doc", "-c", "hello world"]
 */
function parseCliArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuotes = false;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (ch === '"') {
			inQuotes = !inQuotes;
		} else if (ch === " " && !inQuotes) {
			if (current.length > 0) {
				args.push(current);
				current = "";
			}
		} else {
			current += ch;
		}
	}
	if (current.length > 0) {
		args.push(current);
	}
	return args;
}
