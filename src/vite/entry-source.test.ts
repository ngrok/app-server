import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { environmentOptions, serverEntrySource } from "./entry-source.js";

const project = mkdtempSync(join(tmpdir(), "app-server-entry-source-"));
const packageDirectory = join(project, "node_modules/@ngrok/app-server");
mkdirSync(packageDirectory, { recursive: true });
writeFileSync(
	join(packageDirectory, "package.json"),
	JSON.stringify({ type: "module", exports: "./index.js" }),
);
// Why stand-ins that give their argument back: the test reads the options that the entry gives `createServer`.
writeFileSync(
	join(packageDirectory, "index.js"),
	"export const createServer = (options) => options;\nexport const createEntry = (entry) => entry;\n",
);
writeFileSync(
	join(project, "adapter.js"),
	"export const runtime = () => ({});\nexport const host = {};\n",
);
writeFileSync(
	join(project, "entry.js"),
	serverEntrySource({
		framework: { serverModule: "./adapter.js", runtimeModule: "./adapter.js" },
		host: { runtimeModule: "./adapter.js" },
		appModule: undefined,
		clientDirectory: '"build/client"',
	}),
);
writeFileSync(join(project, "package.json"), JSON.stringify({ type: "module" }));

afterAll(() => {
	rmSync(project, { recursive: true, force: true });
});

/** Imports the server entry of a build with no `server.ts` in a new Node.js process, as the CLI does. */
function importEntry(env: Record<string, string>): { status: number | null; output: string } {
	const { status, stdout, stderr } = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			'const { appServer } = await import("./entry.js"); console.log(JSON.stringify(appServer.app));',
		],
		{ cwd: project, env: { PATH: process.env.PATH, ...env }, encoding: "utf8" },
	);
	return { status, output: status === 0 ? stdout.trim() : stderr };
}

describe("environmentOptions", () => {
	it("reads the two trust options, and leaves each off for no value, an empty value, or 0", () => {
		expect(
			environmentOptions({ TRUST_FORWARDED_PROTO: "1", TRUSTED_PROXY_HOPS: "2" }),
		).toStrictEqual({ trustForwardedProto: true, trustedProxyHops: 2 });
		for (const env of [
			{},
			{ TRUST_FORWARDED_PROTO: "", TRUSTED_PROXY_HOPS: "" },
			{ TRUST_FORWARDED_PROTO: "0", TRUSTED_PROXY_HOPS: "0" },
		]) {
			expect(environmentOptions(env)).toStrictEqual({
				trustForwardedProto: false,
				trustedProxyHops: 0,
			});
		}
	});

	it.each(["true", "yes", " 1", "01"])(
		"refuses TRUST_FORWARDED_PROTO=%j, and names the variable, the value, and the fix",
		(value) => {
			expect(() => environmentOptions({ TRUST_FORWARDED_PROTO: value })).toThrow(
				`TRUST_FORWARDED_PROTO must be "1" or "0", not "${value}". Set TRUST_FORWARDED_PROTO=1 to trust X-Forwarded-Proto, or remove the variable.`,
			);
		},
	);

	it.each(["abc", "1e2", "0x10", "-1", "1.5", " ", "99999999999999999999"])(
		"refuses TRUSTED_PROXY_HOPS=%j, and names the variable, the value, and the fix",
		(value) => {
			expect(() => environmentOptions({ TRUSTED_PROXY_HOPS: value })).toThrow(
				`TRUSTED_PROXY_HOPS must be an integer of 0 or more, not "${value}". Set it to the number of proxies in front of the server, such as TRUSTED_PROXY_HOPS=1, or remove the variable.`,
			);
		},
	);
});

describe("the server entry of a build with no server.ts", () => {
	it("makes the default app with the trust options of the environment", () => {
		expect(importEntry({ TRUST_FORWARDED_PROTO: "1", TRUSTED_PROXY_HOPS: "2" })).toStrictEqual({
			status: 0,
			output: JSON.stringify({ trustForwardedProto: true, trustedProxyHops: 2 }),
		});
		expect(importEntry({})).toStrictEqual({
			status: 0,
			output: JSON.stringify({ trustForwardedProto: false, trustedProxyHops: 0 }),
		});
	});

	it("stops at startup for a bad value, and names the variable, the value, and the fix", () => {
		const proto = importEntry({ TRUST_FORWARDED_PROTO: "true" });
		const hops = importEntry({ TRUSTED_PROXY_HOPS: "abc" });

		expect(proto.status).toBe(1);
		expect(proto.output).toContain(
			'TRUST_FORWARDED_PROTO must be "1" or "0", not "true". Set TRUST_FORWARDED_PROTO=1 to trust X-Forwarded-Proto, or remove the variable.',
		);
		expect(hops.status).toBe(1);
		expect(hops.output).toContain(
			'TRUSTED_PROXY_HOPS must be an integer of 0 or more, not "abc". Set it to the number of proxies in front of the server, such as TRUSTED_PROXY_HOPS=1, or remove the variable.',
		);
	});
});
