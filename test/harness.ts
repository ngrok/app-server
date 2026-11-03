// Starts the built CLI and the fixture apps on each runtime, for `test/runtimes.ts` and
// `test/bench.ts`.
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";

export const packageDirectory = join(import.meta.dirname, "..");

/** The command that runs `args` with each runtime. */
export const commands: Record<string, (args: string[]) => [string, string[]]> = {
	node: (args) => ["node", args],
	bun: (args) => ["bun", args],
	deno: (args) => [
		"deno",
		[
			"run",
			"--allow-net",
			"--allow-env",
			"--allow-read",
			"--allow-sys",
			// Why: in `start`, Vite loads its native bundler and writes its cache. On Linux, Vite also
			// reads a Windows Subsystem for Linux (WSL) file that only `--allow-all` allows, so Deno
			// ignores that read.
			...(args.includes("start")
				? ["--allow-ffi", "--allow-write", "--ignore-read=/proc/sys/fs/binfmt_misc/WSLInterop"]
				: []),
			...args,
		],
	],
};

export type Line = { level: string; message: string; [attribute: string]: unknown };

/**
 * Starts the CLI and resolves with its URL once it logs `listening`. `prefix`
 * goes before the runtime's command, such as `taskset`. With `record: false`,
 * the lines after `listening` are not kept, so a long load test does not fill
 * the memory.
 *
 * @example
 * const { child, url } = startServer("bun", ["dist/cli.js", "serve", "test/fixtures/runtime-entry.js"]);
 * await fetch(new URL("/cpu", await url));
 * child.kill("SIGTERM");
 */
export function startServer(
	runtime: string,
	cliArgs: string[],
	{
		cwd = packageDirectory,
		env = {},
		stderr = "inherit",
		prefix = [],
		record = true,
	}: {
		cwd?: string;
		env?: Record<string, string>;
		stderr?: "inherit" | "ignore";
		prefix?: string[];
		record?: boolean;
	} = {},
): { child: ChildProcessByStdio<null, Readable, null>; lines: Line[]; url: Promise<string> } {
	const [command, args] = commands[runtime]?.(cliArgs) ?? ["", []];
	const [program = command, ...prefixArgs] = prefix;
	const child = spawn(program, prefix.length > 0 ? [...prefixArgs, command, ...args] : args, {
		cwd,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", stderr],
	});
	const lines: Line[] = [];
	let buffered = "";
	const url = new Promise<string>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => {
			reject(new Error(`${runtime} exited with ${code} before it listened`));
		});
		function read(chunk: Buffer): void {
			buffered += chunk.toString();
			const parts = buffered.split("\n");
			buffered = parts.pop() ?? "";
			// Why the filter: Vite in `start` and the fixture at shutdown write lines that are not JSON.
			for (const part of parts.filter((candidate) => candidate.startsWith("{"))) {
				const line: Line = JSON.parse(part);
				lines.push(line);
				const urls = line["app_server.urls"];
				if (line.message === "listening" && Array.isArray(urls)) {
					resolve(String(urls[0]));
					if (!record) {
						// Why resume: the server blocks when nobody reads its log.
						child.stdout.off("data", read);
						child.stdout.resume();
					}
				}
			}
		}
		child.stdout.on("data", read);
	});
	return { child, lines, url };
}

/**
 * Builds the framework fixture apps of the checkout at `root` with its built package.
 *
 * @example
 * buildFixtures("base"); // builds base/test/fixtures/react-router and base/test/fixtures/tanstack-start
 */
export function buildFixtures(root = packageDirectory): void {
	const bin = join(root, "node_modules/.bin");
	execFileSync(`${bin}/react-router`, ["build"], {
		cwd: join(root, "test/fixtures/react-router"),
		stdio: ["ignore", "ignore", "inherit"],
	});
	execFileSync(`${bin}/vite`, ["build"], {
		cwd: join(root, "test/fixtures/tanstack-start"),
		stdio: ["ignore", "ignore", "inherit"],
	});
}
