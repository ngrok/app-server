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
		cli: "./src/cli.ts",
		index: "./src/index.ts",
		"react-router": "./src/react-router.ts",
		vite: "./src/vite.ts",
	},
});
