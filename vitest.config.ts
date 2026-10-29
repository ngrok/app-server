import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
		// See `packages/mantle/vitest.config.ts`: docs/testing.md § Determinism documents this as repo-wide.
		clearMocks: true,
		restoreMocks: true,
		unstubEnvs: true,
		unstubGlobals: true,
		env: {
			TZ: "UTC",
		},
	},
});
