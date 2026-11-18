// A qdrant pid file can name a reused pid after a crash or reboot. The managed controller signals
// only a process running the managed binary; an unrelated live process survives.
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { defaultProcessController } from "../../src/runtime/qdrant.ts";

test("stop leaves an unrelated live process alone when the pid is not the managed binary", async () => {
  const [cmd, args] =
    process.platform === "win32" ? ["ping", ["-n", "60", "127.0.0.1"]] : ["sleep", ["60"]];
  const child = spawn(cmd as string, args as string[], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const pid = child.pid as number;
    await defaultProcessController.stop(pid, 500, {
      path: "/nonexistent/runtime/qdrant/bin/qdrant",
    });
    expect(defaultProcessController.alive(pid)).toBe(true);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  } finally {
    child.kill();
  }
});
