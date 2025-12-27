#!/usr/bin/env node
/**
 * Build CLI using esbuild (works with both Node.js and Bun)
 */

import * as esbuild from "esbuild";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

// Ensure dist directories exist
mkdirSync(join(rootDir, "dist", "mcp"), { recursive: true });

// Plugin to strip shebang from source files
const stripShebangPlugin = {
	name: "strip-shebang",
	setup(build) {
		build.onLoad({ filter: /\.(ts|js)$/ }, async (args) => {
			let contents = readFileSync(args.path, "utf8");
			// Remove shebang if present
			if (contents.startsWith("#!")) {
				contents = contents.replace(/^#!.*\n/, "");
			}
			return {
				contents,
				loader: args.path.endsWith(".ts") ? "ts" : "js",
			};
		});
	},
};

// Banner to add shebang and create require for ESM
const esmBanner = `#!/usr/bin/env node
import { createRequire } from 'module';
import { fileURLToPath as __fileURLToPath } from 'url';
import { dirname as __dirname_fn } from 'path';
const require = createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_fn(__filename);
`;

// Common build options
const commonOptions = {
	bundle: true,
	platform: "node",
	target: "node18",
	format: "esm",
	sourcemap: false,
	minify: false,
	plugins: [stripShebangPlugin],
	banner: {
		js: esmBanner,
	},
};

async function build() {
	console.log("Building CLI with esbuild...");

	// Build main CLI
	await esbuild.build({
		...commonOptions,
		entryPoints: [join(rootDir, "src", "index.ts")],
		outfile: join(rootDir, "dist", "index.js"),
	});
	console.log("  ✓ dist/index.js");

	// Build MCP server
	await esbuild.build({
		...commonOptions,
		entryPoints: [join(rootDir, "src", "mcp", "server.ts")],
		outfile: join(rootDir, "dist", "mcp", "server.js"),
	});
	console.log("  ✓ dist/mcp/server.js");

	console.log("\n✓ Build complete!");
}

build().catch((err) => {
	console.error("Build failed:", err);
	process.exit(1);
});
