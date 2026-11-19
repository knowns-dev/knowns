// A live pid that is not this process and is not the test runner's parent: tests of the daemon
// registry need "another daemon that is alive". process.ppid is not that in a full single-process
// run (the parent may be a wrapper that has already gone), so each test file spawns its own child
// that idles until the file ends.
export interface LivePid {
  pid: number;
  kill(): void;
}

export function spawnLivePid(): LivePid {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1_000_000)"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return {
    pid: child.pid,
    kill: () => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    },
  };
}
