import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defaultClientConditions } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
			},
			adapter: adapter(),
		}),
	],
	resolve: {
		conditions: ["onnxruntime-web-use-extern-wasm", ...defaultClientConditions],
	},
	worker: {
		format: "es",
	},
	test: {
		include: ["tests/**/*.test.ts"],
		deps: { interopDefault: false },
	},
});
