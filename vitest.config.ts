import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Plugin, defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Plugin to handle .md file imports in tests
 */
function mdLoaderPlugin(): Plugin {
	return {
		name: "md-loader",
		transform(code, id) {
			if (id.endsWith(".md")) {
				const content = readFileSync(id, "utf-8");
				return {
					code: `export default ${JSON.stringify(content)};`,
					map: null,
				};
			}
		},
	};
}

export default defineConfig({
	plugins: [mdLoaderPlugin()],
	test: {
		include: ["src/**/*.test.ts"],
		exclude: ["src/ui/**", "node_modules/**"],
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov", "html"],
			reportsDirectory: "./coverage",
			exclude: [
				"node_modules/**",
				"src/ui/**",
				"**/*.test.ts",
				"**/index.ts",
				"scripts/**",
			],
		},
	},
	resolve: {
		alias: {
			"@": resolve(__dirname, "src"),
			"@commands": resolve(__dirname, "src/commands"),
			"@models": resolve(__dirname, "src/models"),
			"@storage": resolve(__dirname, "src/storage"),
			"@server": resolve(__dirname, "src/server"),
			"@utils": resolve(__dirname, "src/utils"),
			"@codegen": resolve(__dirname, "src/codegen"),
			"@instructions": resolve(__dirname, "src/instructions"),
		},
	},
});
