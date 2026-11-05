// os.Getwd semantics. On unix Go returns $PWD when it is absolute and names the same directory as
// ".", so a shell that cd'd through a symlink keeps the symlinked path (and `knowns init` names the
// project after the link, not its target). process.cwd() always returns the resolved path. On
// Windows Go calls the system Getwd directly and ignores PWD.
import { statSync } from "node:fs";

export function goGetwd(env: Record<string, string | undefined> = process.env): string {
  const cwd = process.cwd();
  if (process.platform === "win32") return cwd;
  const pwd = env.PWD;
  if (!pwd || !pwd.startsWith("/")) return cwd;
  try {
    const a = statSync(pwd);
    const b = statSync(".");
    if (a.dev === b.dev && a.ino === b.ino) return pwd;
  } catch {
    // PWD is stale or unreadable: fall back like Go does.
  }
  return cwd;
}
