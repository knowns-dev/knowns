// Port of internal/storage/config_split.go: where a store-linked project keeps the settings that
// belong to one person or one machine instead of the team (store spec D13).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RegistryProject } from "../../models/registry.ts";
import { globalRootPath } from "../core/global-root.ts";
import { decodeGenericObject, writeCanonicalJson } from "../core/util.ts";
import type { JsonObject } from "./go-shape.ts";
import { Registry } from "./registry.ts";

export const PERSONAL_SETTING_KEYS = ["defaultAssignee", "platforms"] as const;
export const MACHINE_SETTING_KEYS = ["serverPort", "lsp"] as const;

/** Top-level key of ~/.knowns/settings.json holding personal settings per store-linked project. */
export const PROJECT_SETTINGS_KEY = "projectSettings";

function isObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** settingsMap: raw.settings as an object, created when missing or not an object. */
export function settingsMap(raw: JsonObject): JsonObject {
  const s = raw.settings;
  if (isObject(s)) return s;
  const created: JsonObject = {};
  raw.settings = created;
  return created;
}

function readGenericJson(path: string): JsonObject {
  const text = readFileSync(path, "utf8");
  try {
    return decodeGenericObject(text);
  } catch (e) {
    throw new Error(`parse ${path}: ${(e as Error).message}`);
  }
}

export class ConfigSplit {
  readonly settingsPath: string;
  readonly registryPath: string;

  constructor(readonly projectRoot: string) {
    const global = globalRootPath();
    this.settingsPath = join(global, "settings.json");
    this.registryPath = join(global, "registry.json");
  }

  /** overlay: copy personal and machine settings from their homes into raw.settings. */
  overlay(raw: JsonObject): void {
    const settings = settingsMap(raw);
    for (const [k, v] of Object.entries(this.readPersonal() ?? {})) settings[k] = v;
    const project = this.registryProject(false);
    if (project?.machine) {
      for (const [k, v] of Object.entries(project.machine)) settings[k] = v;
    }
  }

  /** storeOwned: move personal and machine settings out of raw into their homes. */
  storeOwned(raw: JsonObject): void {
    const settings = settingsMap(raw);
    const personal: JsonObject = {};
    for (const key of PERSONAL_SETTING_KEYS) {
      if (Object.hasOwn(settings, key)) {
        personal[key] = settings[key];
        delete settings[key];
      }
    }
    const machine: JsonObject = {};
    for (const key of MACHINE_SETTING_KEYS) {
      if (Object.hasOwn(settings, key)) {
        machine[key] = settings[key];
        delete settings[key];
      }
    }

    this.writePersonal(personal);
    const project = this.registryProject(true);
    if (!project) {
      if (Object.keys(machine).length > 0) {
        throw new Error(
          `save machine settings: ${this.projectRoot} is not linked to a store in ${this.registryPath}`,
        );
      }
      return;
    }
    const reg = new Registry(this.registryPath);
    try {
      reg.load();
    } catch (e) {
      throw new Error(`save machine settings: ${(e as Error).message}`);
    }
    reg.setMachine(project.path, machine);
  }

  /** personalKey: the registry ID of the project, or its path when the registry does not know it. */
  personalKey(): string {
    const project = this.registryProject(false);
    return project && project.id !== "" ? project.id : this.projectRoot;
  }

  private readPersonal(): JsonObject | undefined {
    let raw: JsonObject;
    try {
      raw = readGenericJson(this.settingsPath);
    } catch {
      return undefined;
    }
    const all = raw[PROJECT_SETTINGS_KEY];
    if (!isObject(all)) return undefined;
    const mine = all[this.personalKey()];
    return isObject(mine) ? mine : undefined;
  }

  private writePersonal(personal: JsonObject): void {
    let raw: JsonObject | undefined;
    try {
      raw = readGenericJson(this.settingsPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" && !/ENOENT/.test((e as Error).message)) {
        throw new Error(`save personal settings: ${(e as Error).message}`);
      }
    }
    raw ??= {};
    const existing = raw[PROJECT_SETTINGS_KEY];
    const all: JsonObject = isObject(existing) ? existing : {};
    const key = this.personalKey();
    if (Object.keys(personal).length === 0) {
      if (!Object.hasOwn(all, key)) return;
      delete all[key];
    } else {
      all[key] = personal;
    }
    if (Object.keys(all).length === 0) delete raw[PROJECT_SETTINGS_KEY];
    else raw[PROJECT_SETTINGS_KEY] = all;
    writeCanonicalJson(this.settingsPath, raw);
  }

  private registryProject(repair: boolean): RegistryProject | undefined {
    const reg = new Registry(this.registryPath);
    try {
      if (repair) reg.load();
      else reg.loadReadOnly();
    } catch {
      return undefined;
    }
    return reg.findStoreLinked(this.projectRoot);
  }
}
