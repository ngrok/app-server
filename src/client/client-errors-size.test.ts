import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { clientErrorsScript } from "./client-errors-script.js";

describe("the size of the client error reporter", () => {
	it("has an inline script of 1.3 KB or less of gzip", () => {
		expect(gzipSync(clientErrorsScript()).byteLength).toBeLessThanOrEqual(1300);
	});

	it("adds 0.6 KB or less of gzip to an app's client bundle", async () => {
		const output = await build({
			configFile: false,
			logLevel: "silent",
			build: {
				write: false,
				minify: true,
				lib: { entry: resolve(import.meta.dirname, "client-errors.ts"), formats: ["es"] },
			},
		});
		const [chunk] = (Array.isArray(output) ? output : [output]).flatMap((result) =>
			"output" in result ? result.output : [],
		);

		// Why also the imports: the bundle must hold no server code, such as Hono.
		expect(chunk?.type === "chunk" ? chunk.imports : undefined).toStrictEqual([]);
		expect(gzipSync(chunk?.type === "chunk" ? chunk.code : "").byteLength).toBeGreaterThan(200);
		expect(gzipSync(chunk?.type === "chunk" ? chunk.code : "").byteLength).toBeLessThanOrEqual(600);
	});
});
