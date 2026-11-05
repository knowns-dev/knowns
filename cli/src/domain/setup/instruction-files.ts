// createInstructionFilesForPlatforms and writeInstructionFile (internal/cli/init.go).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateInstructionContent, syncInstructionMarkerBlock } from "../instructions/index.ts";
import { defaultInstructionFiles, shouldCreateInstructionFile } from "./platforms.ts";

/**
 * writeInstructionFile: an existing file is left alone unless forced, and then only its managed
 * marker block is refreshed; a new file gets the whole shim.
 */
export function writeInstructionFile(
  projectRoot: string,
  relativePath: string,
  platform: string,
  force: boolean,
): void {
  const filePath = join(projectRoot, relativePath);
  const fileExists = existsSync(filePath);
  if (fileExists && !force) return;
  const dir = dirname(filePath);
  if (dir !== projectRoot) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o755 });
    } catch (e) {
      throw new Error(`create directory ${dir}: ${(e as Error).message}`);
    }
  }
  const content = generateInstructionContent(relativePath, platform, projectRoot);
  if (fileExists) {
    syncInstructionMarkerBlock(filePath, content);
    return;
  }
  try {
    writeFileSync(filePath, content, { mode: 0o644 });
  } catch (e) {
    throw new Error(`could not create ${relativePath}: ${(e as Error).message}`);
  }
}

/** createInstructionFilesForPlatforms: only the files the platforms call for (empty = all). */
export function createInstructionFilesForPlatforms(
  projectRoot: string,
  force: boolean,
  platforms: readonly string[],
): void {
  for (const f of defaultInstructionFiles) {
    if (!shouldCreateInstructionFile(platforms, f)) continue;
    writeInstructionFile(projectRoot, f.path, f.platform, force);
  }
}

/** createInstructionFilesQuiet: every instruction file. */
export function createInstructionFiles(projectRoot: string, force: boolean): void {
  for (const f of defaultInstructionFiles)
    writeInstructionFile(projectRoot, f.path, f.platform, force);
}
