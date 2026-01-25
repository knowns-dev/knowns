/**
 * Import System
 *
 * Import and sync templates/docs from external sources.
 *
 * @example
 * ```typescript
 * import { importSource, syncImport } from "./import";
 *
 * // Import from git
 * await importSource(projectRoot, "https://github.com/org/templates.git");
 *
 * // Import from npm
 * await importSource(projectRoot, "@org/templates", { type: "npm" });
 *
 * // Import from local with symlink
 * await importSource(projectRoot, "../shared", { link: true });
 *
 * // Sync existing import
 * await syncImport(projectRoot, "templates");
 * ```
 */

// Models
export type {
	FileChange,
	ImportConfig,
	ImportMetadata,
	ImportOptions,
	ImportResult,
	ImportType,
	SyncOptions,
	ValidationResult,
} from "./models";

export { ImportError, ImportErrorCode } from "./models";

// Config
export {
	getConfigPath,
	getImportConfig,
	getImportConfigs,
	getImportDir,
	getImportsDir,
	getImportsWithMetadata,
	getKnownsDir,
	getMetadataPath,
	importExists,
	readConfig,
	readMetadata,
	removeImportConfig,
	saveImportConfig,
	writeConfig,
	writeMetadata,
} from "./config";

// Validator
export {
	assertValidKnownsDir,
	detectImportType,
	generateImportName,
	validateImportName,
	validateKnownsDir,
} from "./validator";

// Providers
export { getProvider, ImportProvider, type FetchOptions } from "./providers";

// Service
export { importSource, removeImport, syncAllImports, syncImport } from "./service";

// Resolver
export {
	getDocDirectories,
	getTemplateDirectories,
	listAllDocs,
	listAllTemplates,
	resolveDoc,
	resolveDocWithContext,
	resolveTemplate,
	validateRefs,
	type RefValidation,
	type ResolvedSource,
} from "./resolver";
