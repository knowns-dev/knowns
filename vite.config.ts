import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8"));
const isProd = process.env.NODE_ENV === "production";

// Dev: use separate API server, Prod: use relative URLs (same server)
const API_URL = isProd ? "" : (process.env.API_URL || "http://localhost:6420");
const WS_URL = isProd ? "" : (process.env.WS_URL || "ws://localhost:6420");

export default defineConfig({
	plugins: [react(), tailwindcss()],
	root: "src/ui",
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
		},
	},
	server: {
		port: 6420,
	},
	build: {
		outDir: path.resolve(__dirname, "dist/ui"),
		emptyOutDir: true,
	},
	define: {
		"import.meta.env.API_URL": JSON.stringify(API_URL),
		"import.meta.env.WS_URL": JSON.stringify(WS_URL),
		"import.meta.env.APP_VERSION": JSON.stringify(pkg.version),
	},
});
