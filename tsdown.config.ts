import { defineConfig } from "tsdown";

export default defineConfig({
	dts: true,
	clean: true,
	deps: {
		neverBundle: [
			//,
			"@hono/node-server",
			"hono",
			"react-router",
			"vite",
		],
	},
	minify: false,
	sourcemap: true,
	target: "ES2025",
	tsconfig: "tsconfig.json",
	fixedExtension: false,
	format: "esm",
	entry: {
		cli: "./src/cli/cli.ts",
		client: "./src/client/index.ts",
		"client-browser": "./src/client/browser.ts",
		index: "./src/core/index.ts",
		node: "./src/node/index.ts",
		"node-vite": "./src/node/vite.ts",
		"react-router": "./src/react-router/index.ts",
		"react-router-vite": "./src/react-router/vite.ts",
		"tanstack-start": "./src/tanstack-start/index.ts",
		"tanstack-start-vite": "./src/tanstack-start/vite.ts",
		testing: "./src/testing/index.ts",
		vercel: "./src/vercel/index.ts",
		"vercel-vite": "./src/vercel/vite.ts",
		vite: "./src/vite/index.ts",
	},
});
