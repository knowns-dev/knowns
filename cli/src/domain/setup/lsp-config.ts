// autoInstallLSPServers' persistence half: record the detected languages in config.json
// (settings.lsp). The download of missing language servers is not ported.
import type { ConfigStore } from "../../storage/stores/config-store.ts";
import { detectLanguages } from "./lsp-detect.ts";

/** Returns the detected language ids. Never throws: a failure is non-blocking in Go. */
export function recordDetectedLanguages(cwd: string, config: ConfigStore | undefined): string[] {
  const detected = detectLanguages(cwd);
  if (detected.length === 0 || !config) return detected;
  try {
    const project = config.load();
    const settings = project.settings;
    if (!settings.lsp) settings.lsp = { enabled: true, languages: {} };
    const lsp = settings.lsp;
    if (!lsp.languages) lsp.languages = {};
    let changed = false;
    for (const id of detected) {
      if (!Object.hasOwn(lsp.languages, id)) {
        lsp.languages[id] = { enabled: true };
        changed = true;
      }
    }
    if (changed) {
      lsp.enabled = true;
      config.save(project);
    }
  } catch {
    // Go ignores a config load or save failure here.
  }
  return detected;
}
