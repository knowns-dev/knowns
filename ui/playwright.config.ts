import { defineConfig } from "@playwright/test";

const isCI = !!process.env.CI;

export default defineConfig({
	testDir: "./e2e",
	timeout: isCI ? 90_000 : 60_000,
	retries: isCI ? 1 : 0,
	workers: 1, // sequential — each test manages its own server
	reporter: [["list"], ["html", { open: "never" }]],
	expect: {
		timeout: isCI ? 10_000 : 5_000,
	},
	use: {
		headless: true,
		// The graph renders through Sigma/WebGL. Headless Chromium has no GPU
		// backend, so without SwiftShader every graph test would only ever see
		// the crash/fallback path instead of the real renderer.
		launchOptions: { args: ["--enable-unsafe-swiftshader"] },
		// The graph renders through Sigma/WebGL. Headless Chromium ships no GPU
		// backend, so without SwiftShader every graph test would only ever see
		// the no-WebGL fallback instead of the real renderer.
		screenshot: "on",
		trace: "on",
		actionTimeout: isCI ? 15_000 : 10_000,
	},
	projects: [
		{
			name: "chromium",
			use: { browserName: "chromium" },
		},
	],
});
