/**
 * Custom loader for tsx to handle .md files as text
 * Usage: tsx --import ./scripts/md-loader.mjs src/index.ts
 */

import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./md-loader-hooks.mjs", pathToFileURL("./scripts/"));
