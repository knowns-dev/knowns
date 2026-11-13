// The in-process TS CLI (runTs) reads the machine root, the runtime knobs, PATH lookups and
// fetch's proxy settings from process.env, not from the env handed to execute. A real binary gets
// all of them from its environment, so a harness that runs the CLI in-process must put the
// sandbox env on process.env for the duration of the call and restore it afterwards.
export async function withProcessEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
  opts: { keepPath?: boolean } = {},
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (opts.keepPath && k === "PATH") continue;
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// The user home, as every OS resolves it: HOME on unix, USERPROFILE on Windows (Go's
// os.UserHomeDir and libuv's homedir). A test that moves HOME alone leaves Windows code reading
// the other home, so every home isolation goes through these two.

/** The env entries that point the user home at `home` on every OS. */
export function homeEnv(home: string): { HOME: string; USERPROFILE: string } {
  return { HOME: home, USERPROFILE: home };
}

/** Points process.env's user home at `home`; returns a function that restores the previous one. */
export function setProcessHome(home: string): () => void {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, homeEnv(home));
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}
