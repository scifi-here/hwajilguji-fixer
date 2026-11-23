import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	reporter: "list",
	outputDir: "./test-results",
	use: { baseURL: "http://localhost:4173" },
	webServer: {
		command: "pnpm preview --port 4173 --strictPort",
		port: 4173,
		reuseExistingServer: false,
		stdout: "pipe",
		stderr: "pipe",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
