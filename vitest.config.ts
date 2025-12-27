import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		exclude: ["src/ui/**", "node_modules/**"],
	},
	resolve: {
		alias: {
			"@": resolve(__dirname, "src"),
			"@commands": resolve(__dirname, "src/commands"),
			"@models": resolve(__dirname, "src/models"),
			"@storage": resolve(__dirname, "src/storage"),
			"@server": resolve(__dirname, "src/server"),
			"@utils": resolve(__dirname, "src/utils"),
		},
	},
});
