// A stand-in for the proxy: `knowns mcp --stdio` served by a runtime daemon over the MCP endpoint.
// The MCP test harness runs it instead of `mcp --stdio` when KNOWNS_MCP_TEST_VIA_DAEMON=1, so the
// same suites prove that a session on the daemon answers exactly like an in-process one (AC-2).
// It starts the sandboxed daemon itself, sends the hello, pipes stdin/stdout, and stops the daemon.
import { spawn } from "node:child_process";
import net from "node:net";
import { join } from "node:path";
import { readDescriptor } from "../../src/runtime/mcp-endpoint.ts";
import { runtimeRoot } from "../../src/runtime/queue.ts";
import { VERSION } from "../../src/version.ts";

const main = join(import.meta.dir, "..", "..", "src", "main.ts");
const args = process.argv.slice(2);
const flag = (name: string): string => {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1] ?? "";
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : "";
};
const project = flag("project") || process.env.KNOWNS_PROJECT || "";

const daemon = spawn(process.execPath, [main, "__runtime", "run"], {
  stdio: ["ignore", "ignore", "ignore"],
  env: process.env,
});
const stopDaemon = (): void => {
  try {
    daemon.kill("SIGTERM");
  } catch {
    // gone
  }
};

async function descriptor() {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    const d = readDescriptor(VERSION, runtimeRoot());
    if (d && d.pid === daemon.pid) return d;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("daemon endpoint did not appear");
}

const d = await descriptor();
const sock = net.connect({ path: d.address });
sock.write(
  `${JSON.stringify({
    knowns_mcp: 1,
    type: "hello",
    version: VERSION,
    token: d.token,
    pid: process.pid,
    cwd: process.cwd(),
    project,
    client: { name: "test-bridge" },
  })}\n`,
);

let head: Buffer = Buffer.alloc(0);
let welcomed = false;
sock.on("data", (chunk: Buffer) => {
  if (welcomed) {
    process.stdout.write(chunk);
    return;
  }
  head = Buffer.concat([head, chunk]);
  const nl = head.indexOf(0x0a);
  if (nl < 0) return;
  const first = JSON.parse(head.subarray(0, nl).toString("utf8")) as {
    type?: string;
    code?: string;
  };
  if (first.type !== "welcome") {
    process.stderr.write(`daemon refused the session: ${first.code}\n`);
    stopDaemon();
    process.exit(3);
  }
  welcomed = true;
  const rest = head.subarray(nl + 1);
  if (rest.length > 0) process.stdout.write(rest);
});
sock.on("error", () => {
  stopDaemon();
  process.exit(2);
});
sock.on("close", () => {
  stopDaemon();
  process.exit(0);
});
process.stdin.on("data", (c) => sock.write(c));
// No more requests: ask the daemon to answer what it has and close (a half-close would not do).
process.stdin.on("end", () => sock.write(`${JSON.stringify({ knowns_mcp: 1, type: "close" })}\n`));
