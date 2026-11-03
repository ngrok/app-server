import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const benchPath = join(import.meta.dirname, "bench.ts");

let directory = "";

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "app-server-bench-"));
	return () => {
		rmSync(directory, { recursive: true, force: true });
	};
});

type Sample = { route: string; side: "base" | "head"; outcome: string; rps?: number };

/** Writes the results of one runtime, as one benchmark job uploads them. */
function writeResults(runtime: string, cpu: string, samples: Sample[]): string {
	const file = join(directory, `bench-${runtime}.json`);
	const sides = new Set(samples.map((sample) => sample.side));
	writeFileSync(
		file,
		JSON.stringify({
			meta: {
				cpu,
				cpus: 4,
				platform: "linux",
				pinned: false,
				rounds: 1,
				seconds: 5,
				connections: 64,
				commits: { ...(sides.has("base") ? { base: "aaaaaaa" } : {}), head: "bbbbbbb" },
				versions: { [runtime]: "v1.0.0" },
			},
			samples: samples.map((sample) => ({
				runtime,
				app: "react-router",
				p99Ms: 1,
				...sample,
			})),
		}),
	);
	return file;
}

/** Runs `bench.ts report` and returns its exit status and Markdown. */
function report(...files: string[]): { status: number | null; markdown: string } {
	const result = spawnSync(process.execPath, [benchPath, "report", ...files], { encoding: "utf8" });
	return { status: result.status, markdown: result.stdout };
}

describe("bench.ts report", () => {
	it("fails when a head server exits and there is no base", () => {
		const { status, markdown } = report(
			writeResults("node", "CPU A", [{ route: "ssr", side: "head", outcome: "exits" }]),
		);
		expect(status).toBe(1);
		expect(markdown).toContain("| `/ssr` rendered | exits ⚠️ |");
	});

	it("fails when a head route fails and the base route works", () => {
		const { status, markdown } = report(
			writeResults("node", "CPU A", [
				{ route: "api", side: "base", outcome: "ok", rps: 100 },
				{ route: "api", side: "head", outcome: "fails" },
			]),
		);
		expect(status).toBe(1);
		expect(markdown).toContain("| 100 | fails | fails ⚠️ |");
	});

	it("passes when the base server exits too", () => {
		const { status } = report(
			writeResults("bun", "CPU A", [
				{ route: "ssr", side: "base", outcome: "exits" },
				{ route: "ssr", side: "head", outcome: "exits" },
			]),
		);
		expect(status).toBe(0);
	});

	it("names the machine of each runtime", () => {
		const { markdown } = report(
			writeResults("node", "CPU A", [{ route: "api", side: "head", outcome: "ok", rps: 100 }]),
			writeResults("deno", "CPU B", [{ route: "api", side: "head", outcome: "ok", rps: 100 }]),
		);
		expect(markdown).toContain("- node v1.0.0: CPU A, 4 CPUs, linux.");
		expect(markdown).toContain("- deno v1.0.0: CPU B, 4 CPUs, linux.");
	});
});
