import { AsyncLocalStorage } from "node:async_hooks";

// The in-process TS CLI (runTs) reads the machine root, the runtime knobs, PATH lookups and
// fetch's proxy settings from process.env, not from the env handed to execute. A real binary gets
// all of them from its environment, so a harness that runs the CLI in-process must put the
// sandbox env on process.env for the duration of the call and restore it afterwards.
//
// Calls may overlap (a test that runs five in-process commands with Promise.all). Each call used to
// save what it found and put that back when it ended, so the second call saved the first call's
// value and, finishing last, left it behind: HOME stayed on a dead sandbox for every later file.
// Now the first top-level call in flight records the real values of the keys it touches, later
// overlapping top-level calls only add keys, and the last one to finish restores the recorded
// originals. Overlapping calls must agree on the values; two different ones cannot both be on
// process.env anyway. A call made from inside another one (the harness wraps runTs, which wraps
// again) is nested, not concurrent, and still restores what its caller had set.
const originals = new Map<string, string | undefined>();
let inFlight = 0;
const nesting = new AsyncLocalStorage<true>();

function apply(env: Record<string, string | undefined>, keepPath: boolean | undefined): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (keepPath && k === "PATH") continue;
    keys.push(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return keys;
}

export async function withProcessEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
  opts: { keepPath?: boolean } = {},
): Promise<T> {
  if (nesting.getStore()) {
    const saved = new Map<string, string | undefined>();
    for (const k of Object.keys(env)) {
      if (!(opts.keepPath && k === "PATH")) saved.set(k, process.env[k]);
    }
    apply(env, opts.keepPath);
    try {
      return await fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }
  inFlight++;
  for (const k of Object.keys(env)) {
    if (!(opts.keepPath && k === "PATH") && !originals.has(k)) originals.set(k, process.env[k]);
  }
  apply(env, opts.keepPath);
  try {
    return await nesting.run(true, fn);
  } finally {
    if (--inFlight === 0) {
      for (const [k, v] of originals) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      originals.clear();
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
