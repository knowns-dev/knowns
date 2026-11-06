// D5: MCP readiness (process start to the initialize response) at most 150ms. Measured on a compiled
// binary: set KNOWNS_TS_BIN to dist/<platform>/knowns(.exe).
import { describe, expect, test } from "bun:test";
import { makeSandbox, TS_BIN } from "./harness.ts";

describe.skipIf(!TS_BIN)("MCP readiness budget", () => {
  test("initialize answers within 150ms (median of 9)", async () => {
    const sb = makeSandbox("full");
    const times: number[] = [];
    for (let i = 0; i < 9; i++) {
      const t0 = performance.now();
      const p = Bun.spawn([TS_BIN as string, "mcp", "--stdio"], {
        cwd: sb.dir,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: sb.home,
          USERPROFILE: sb.home,
          NO_UPDATE_CHECK: "1",
          CI: "1",
          KNOWNS_RUNTIME_INLINE: "1",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      p.stdin.write(
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}\n',
      );
      p.stdin.flush();
      await p.stdout.getReader().read();
      times.push(performance.now() - t0);
      p.kill();
    }
    times.sort((a, b) => a - b);
    console.log(
      `mcp readiness median ${times[4]?.toFixed(0)}ms (min ${times[0]?.toFixed(0)}, max ${times[8]?.toFixed(0)})`,
    );
    expect(times[4] as number).toBeLessThanOrEqual(150);
  }, 60_000);
});
