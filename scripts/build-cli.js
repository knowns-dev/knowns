/**
 * Build CLI using esbuild (works with both Node.js and Bun)
 * Run with: node scripts/build-cli.js
 */

import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

// Shebang (added separately to avoid BOM issues on Windows)
const shebang = "#!/usr/bin/env node\n";

// Banner to create require for ESM (shebang added after build)
const esmBanner = `import { createRequire } from 'module';
import { fileURLToPath as __fileURLToPath } from 'url';
import { dirname as __dirname_fn } from 'path';
const require = createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_fn(__filename);
`;

// Add shebang to built file (ensures it's first, no BOM, removes old shebangs)
function addShebang(filePath) {
	let content = readFileSync(filePath, "utf8");
	// Remove BOM if present
	if (content.charCodeAt(0) === 0xfeff) {
		content = content.slice(1);
	}
	// Remove any existing shebangs (handles Windows line endings too)
	while (content.startsWith("#!")) {
		content = content.replace(/^#![^\r\n]*[\r\n]+/, "");
	}
	writeFileSync(filePath, shebang + content, "utf8");
}

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
	loader: {
		".md": "text", // Load markdown files as text strings
	},
};

async function build() {
	console.log("Building CLI with esbuild...");

	const mainOut = join(rootDir, "dist", "index.js");
	const mcpOut = join(rootDir, "dist", "mcp", "server.js");

	// Build main CLI
	await esbuild.build({
		...commonOptions,
		entryPoints: [join(rootDir, "src", "index.ts")],
		outfile: mainOut,
	});
	addShebang(mainOut);
	console.log("  ✓ dist/index.js");

	// Build MCP server
	await esbuild.build({
		...commonOptions,
		entryPoints: [join(rootDir, "src", "mcp", "server.ts")],
		outfile: mcpOut,
	});
	addShebang(mcpOut);
	console.log("  ✓ dist/mcp/server.js");

	console.log("\n✓ Build complete!");
}

build().catch((err) => {
	console.error("Build failed:", err);
	process.exit(1);
});
