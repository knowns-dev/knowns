// Port of internal/storage/user_prefs_store.go: ~/.knowns/preferences.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { goJsonStringify, parseJsonPreservingNumbers } from "../core/util.ts";
import { isNotFound } from "./internal.ts";

/** UserPrefs is an empty struct in 0.34.1; unknown keys are dropped on save, as in Go. */
export type UserPrefs = Record<string, never>;

export class UserPrefsStore {
  constructor(
    readonly filePath: string = join(process.env.HOME || homedir(), ".knowns", "preferences.json"),
  ) {}

  load(): UserPrefs {
    let data: string;
    try {
      data = readFileSync(this.filePath, "utf8");
    } catch (e) {
      if (isNotFound(e)) return {};
      throw new Error(`read user prefs: ${(e as Error).message}`);
    }
    try {
      parseJsonPreservingNumbers(data);
    } catch (e) {
      throw new Error(`parse user prefs: ${(e as Error).message}`);
    }
    return {};
  }

  /** Save: indented JSON with no trailing newline (os.WriteFile of MarshalIndent output). */
  save(prefs: UserPrefs = {}): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o755 });
    writeFileSync(this.filePath, goJsonStringify(prefs), { mode: 0o644 });
  }
}
