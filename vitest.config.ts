import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
		// Why: each test starts with fresh mocks, env, and globals, and a fixed time zone.
		clearMocks: true,
		restoreMocks: true,
		unstubEnvs: true,
		unstubGlobals: true,
		env: {
			TZ: "UTC",
		},
	},
});
