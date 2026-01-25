/**
 * Import Providers
 *
 * Export all import providers.
 */

export { ImportProvider, type FetchOptions } from "./base";
export { GitProvider, gitProvider } from "./git";
export { NpmProvider, npmProvider } from "./npm";
export { LocalProvider, localProvider } from "./local";

import type { ImportType } from "../models";
import { ImportError, ImportErrorCode } from "../models";
import type { ImportProvider } from "./base";
import { gitProvider } from "./git";
import { localProvider } from "./local";
import { npmProvider } from "./npm";

/**
 * Get provider for import type
 */
export function getProvider(type: ImportType): ImportProvider {
	switch (type) {
		case "git":
			return gitProvider;
		case "npm":
			return npmProvider;
		case "local":
			return localProvider;
		case "registry":
			throw new ImportError(
				"Registry imports are not yet supported",
				ImportErrorCode.INVALID_SOURCE,
				"Use git, npm, or local imports for now",
			);
		default:
			throw new ImportError(`Unknown import type: ${type}`, ImportErrorCode.INVALID_SOURCE);
	}
}
