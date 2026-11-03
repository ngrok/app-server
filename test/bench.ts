// Measures the requests per second of the fixture apps' production builds on each runtime, with
// `oha`. Build the package first.
//
//   node ./test/bench.ts [node|bun|deno ...] [--base <checkout>] [--rounds 3] [--seconds 5] [--json <file>]
//   node ./test/bench.ts report <file.json ...> [--threshold 10]
//
// With `--base`, the script also measures the checkout at that path (with its own build), and base
// and head alternate in each round. `report` merges the JSON files into one Markdown table and
// fails when a route of the head gets slower by more than the threshold in percent, fails, or exits.
import { execFile, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { buildFixtures, commands, packageDirectory, startServer } from "./harness.ts";

const apps = [
	{ name: "react-router", directory: "test/fixtures/react-router", buildDirectory: "build" },
	{ name: "tanstack-start", directory: "test/fixtures/tanstack-start", buildDirectory: "dist" },
];

/** The routes of each app. `asset` is the first script that the home page loads. */
const routes = {
	page: "`/` prerendered",
	ssr: "`/ssr` rendered",
	asset: "`/assets/*.js`",
	api: "`/ping` route",
};
type Route = keyof typeof routes;

// Why these values: 64 connections keep one server process busy, and 5 s of 3 rounds keep a run
// of one runtime near 5 minutes. A browser sends this Accept-Encoding.
const connections = 64;
const warmupSeconds = 1;
const acceptEncoding = "Accept-Encoding: gzip, deflate, br";

type Side = "base" | "head";
/** One measurement. `exits`: the server exited under load. `fails`: a request failed. */
type Sample = { runtime: string; app: string; route: Route; side: Side } & (
	| { outcome: "ok"; rps: number; p99Ms: number }
	| { outcome: "exits" }
	| { outcome: "fails"; reason: string }
);
type Meta = {
	cpu: string;
	cpus: number;
	platform: string;
	pinned: boolean;
	rounds: number;
	seconds: number;
	connections: number;
	commits: Partial<Record<Side, string>>;
	versions: Record<string, string>;
};
type Results = { meta: Meta; samples: Sample[] };

// Why pin on Linux: the server and `oha` then do not take central processing unit (CPU) time from
// each other. macOS has no `taskset`, and a process with a limited CPU set can have other CPU IDs.
const cpuCount = availableParallelism();
const pinned = process.platform === "linux" && cpuCount >= 4 && cpus().length === cpuCount;
const half = Math.floor(cpuCount / 2);
const serverPrefix = pinned ? ["taskset", "-c", `0-${half - 1}`] : [];
const ohaPrefix = pinned ? ["taskset", "-c", `${half}-${cpuCount - 1}`] : [];

/**
 * Sends load to `url` for `seconds` and returns the successful requests per second and the 99th
 * percentile (p99) latency, or the reason when a request fails.
 */
async function load(
	url: string,
	seconds: number,
): Promise<{ rps: number; p99Ms: number } | { failure: string }> {
	const args = [
		"oha",
		"-z",
		`${seconds}s`,
		"-c",
		String(connections),
		"--no-tui",
		"--output-format",
		"json",
		"-H",
		acceptEncoding,
		url,
	];
	const [program = "oha", ...rest] = [...ohaPrefix, ...args];
	const stdout = await new Promise<string>((resolve, reject) => {
		execFile(program, rest, { maxBuffer: 16 * 1024 * 1024 }, (error, output) => {
			if (error?.code === "ENOENT") {
				reject(new Error("`oha` is not on PATH. Run `mise install`.", { cause: error }));
			} else if (error == null) {
				resolve(output);
			} else {
				reject(new Error(`oha failed: ${error.message}`, { cause: error }));
			}
		});
	});
	const output: {
		summary: { total: number };
		latencyPercentiles: { p99: number | null };
		statusCodeDistribution: Record<string, number>;
		errorDistribution: Record<string, number>;
	} = JSON.parse(stdout);
	// Why skip the deadline error: `oha` cancels the requests that are open at the end of the load.
	// Why count only responses: `oha` also counts a reset connection in its requests per second.
	const failed = [
		...Object.keys(output.statusCodeDistribution).filter((code) => !code.startsWith("2")),
		...Object.keys(output.errorDistribution).filter((error) => error !== "aborted due to deadline"),
	];
	const responses = Object.values(output.statusCodeDistribution).reduce(
		(sum, count) => sum + count,
		0,
	);
	if (failed.length > 0 || responses === 0) {
		return { failure: failed.length > 0 ? failed.join(", ") : "no responses" };
	}
	return {
		rps: responses / output.summary.total,
		p99Ms: (output.latencyPercentiles.p99 ?? 0) * 1000,
	};
}

/** Gets `url` and returns its status and body, or the reason when the request fails. */
async function get(
	url: string,
): Promise<{ ok: boolean; status: number; body: string } | { failure: string }> {
	try {
		const response = await fetch(url);
		return { ok: response.ok, status: response.status, body: await response.text() };
	} catch (error) {
		// Why the cause: `fetch` rejects with "fetch failed" and puts the network error in `cause`.
		return { failure: String(error instanceof Error && error.cause != null ? error.cause : error) };
	}
}

/** Stops the server, and kills it when it does not exit within 10 s. */
async function stop(child: ChildProcess): Promise<void> {
	if (child.exitCode != null || child.signalCode != null) {
		return;
	}
	const exited = once(child, "exit");
	const timer = setTimeout(() => {
		child.kill("SIGKILL");
	}, 10_000);
	child.kill("SIGTERM");
	await exited;
	clearTimeout(timer);
}

/**
 * Starts one app's build on one runtime and measures one route. Each route gets
 * its own server, so a route that makes the server exit does not stop the
 * other routes. Returns nothing when the route of the base does not answer with
 * a 2xx.
 */
async function measure(
	runtime: string,
	app: (typeof apps)[number],
	{ route, side, root, seconds }: { route: Route; side: Side; root: string; seconds: number },
): Promise<Sample | undefined> {
	const { child, url } = startServer(runtime, [`${app.buildDirectory}/server/app-server.js`], {
		cwd: join(root, app.directory),
		prefix: serverPrefix,
		record: false,
	});
	// Why listen now: the server can exit before the load ends, and a signal leaves no `exitCode`.
	const exit = once(child, "exit").then(
		() => true,
		() => true,
	);
	const key = { runtime, app: app.name, route, side };
	try {
		const base = await url;
		const home = await get(new URL("/", base).href);
		const asset =
			"body" in home ? /"(?<path>\/assets\/[^"]+\.js)"/u.exec(home.body)?.groups?.path : null;
		const paths: Record<Route, string> = {
			page: "/",
			ssr: "/ssr",
			asset: asset ?? "/assets/none.js",
			api: "/ping",
		};
		const target = new URL(paths[route], base).href;
		const probe = await get(target);
		// Why skip on the base: the base checkout can be older than a route.
		if (side === "base" && "ok" in probe && !probe.ok) {
			return undefined;
		}
		let result: Awaited<ReturnType<typeof load>>;
		if ("failure" in probe) {
			result = probe;
		} else if (probe.ok) {
			// Why keep a warmup failure: the timed load alone can miss a route that fails at the start.
			const warmup = await load(target, warmupSeconds);
			result = "failure" in warmup ? warmup : await load(target, seconds);
		} else {
			result = { failure: `status ${probe.status}` };
		}
		// Why wait: the server can exit just after `oha` closes its connections at the end.
		if (await Promise.race([exit, delay(500).then(() => false)])) {
			return { ...key, outcome: "exits" };
		}
		if ("failure" in result) {
			return { ...key, outcome: "fails", reason: `${target} failed with ${result.failure}` };
		}
		return { ...key, outcome: "ok", ...result };
	} finally {
		await stop(child);
	}
}

function version(runtime: string): string {
	return execFileSync(runtime, ["--version"], { encoding: "utf8" }).split("\n")[0]?.trim() ?? "";
}

function commit(root: string): string {
	return execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], {
		encoding: "utf8",
	}).trim();
}

function median(values: number[]): number {
	const sorted = values.toSorted((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[middle] ?? 0)
		: ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * The medians of one side's samples, `"exits"` or `"fails"` when one sample has that outcome, or
 * nothing with no samples.
 */
function summarize(
	group: Sample[],
	side: Side,
): { rps: number; p99Ms: number } | "exits" | "fails" | undefined {
	const samples = group.filter((sample) => sample.side === side);
	if (samples.length === 0) {
		return undefined;
	}
	for (const outcome of ["exits", "fails"] as const) {
		if (samples.some((sample) => sample.outcome === outcome)) {
			return outcome;
		}
	}
	const measured = samples.filter((sample) => sample.outcome === "ok");
	return {
		rps: median(measured.map((sample) => sample.rps)),
		p99Ms: median(measured.map((sample) => sample.p99Ms)),
	};
}

function cell(summary: ReturnType<typeof summarize>): string {
	if (summary == null) {
		return "n/a";
	}
	return typeof summary === "string" ? summary : Math.round(summary.rps).toLocaleString("en-US");
}

/**
 * One Markdown table of the median of each route, and whether a route of the head got slower than
 * `threshold`, fails, or exits. A failure that the base has too does not count.
 */
function report(files: Results[], threshold: number): { markdown: string; slower: boolean } {
	const meta = files[0]?.meta;
	if (meta == null) {
		throw new Error("`report` needs at least one JSON file.");
	}
	const samples = files.flatMap((file) => file.samples);
	const groups = Map.groupBy(
		samples,
		(sample) => `${sample.runtime}\0${sample.app}\0${sample.route}`,
	);
	const hasBase = samples.some((sample) => sample.side === "base");
	let slower = false;
	// Why a rank: a route that only the head has comes last in the samples.
	const rank = (sample: Sample | undefined) =>
		sample == null
			? 0
			: Object.keys(commands).indexOf(sample.runtime) * 100 +
				apps.findIndex((app) => app.name === sample.app) * 10 +
				Object.keys(routes).indexOf(sample.route);
	const sorted = [...groups.values()].toSorted(([left], [right]) => rank(left) - rank(right));
	const rows = sorted.map((group) => {
		const [{ runtime, app, route } = { runtime: "", app: "", route: "page" as Route }] = group;
		const head = summarize(group, "head");
		const base = summarize(group, "base");
		const p99 = typeof head === "object" ? `${head.p99Ms.toFixed(1)} ms` : "n/a";
		const broken = typeof head === "string" && head !== base;
		slower ||= broken;
		if (!hasBase) {
			return `| ${runtime} | ${app} | ${routes[route]} | ${cell(head)}${broken ? " ⚠️" : ""} | ${p99} |`;
		}
		let change = "n/a";
		if (broken) {
			change = `${head} ⚠️`;
		} else if (typeof head === "object" && typeof base === "object") {
			const percent = ((head.rps - base.rps) / base.rps) * 100;
			const isSlower = percent < -threshold;
			slower ||= isSlower;
			change = `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%${isSlower ? " ⚠️" : ""}`;
		}
		return `| ${runtime} | ${app} | ${routes[route]} | ${cell(base)} | ${cell(head)} | ${change} | ${p99} |`;
	});
	const header = hasBase
		? [
				"| Runtime | App | Route | Base req/s | Head req/s | Change | Head p99 |",
				"| --- | --- | --- | --: | --: | --: | --: |",
			]
		: ["| Runtime | App | Route | req/s | p99 |", "| --- | --- | --- | --: | --: |"];
	const commits = hasBase
		? `Base \`${meta.commits.base}\`, head \`${meta.commits.head}\`.`
		: `Head \`${meta.commits.head}\`.`;
	// Why one line for each file: each runtime runs on its own machine.
	const machines = files.map(
		({ meta: { versions, cpu, cpus: count, platform, pinned: isPinned } }) =>
			`- ${Object.entries(versions)
				.map(([runtime, value]) => `${runtime} ${value}`)
				.join(", ")}: ${cpu}, ${count} CPUs, ${platform}${
				isPinned ? `. The server runs on half of the CPUs, and \`oha\` on the other half.` : "."
			}`,
	);
	const markdown = [
		"<!-- app-server-bench -->",
		"### Benchmarks",
		"",
		...header,
		...rows,
		"",
		`⚠️ marks a route that got slower by more than ${threshold}%, that fails, or whose server exits under load.`,
		"",
		"<details><summary>How this was measured</summary>",
		"",
		`${commits} The production build of each fixture app runs as \`<build>/server/app-server.js\`. For each route, \`oha\` sends ${meta.connections} connections for ${meta.seconds} s after a ${warmupSeconds} s warmup, with \`${acceptEncoding}\`. Each value is the median of ${meta.rounds} round${meta.rounds === 1 ? "" : "s"}${hasBase ? ", and base and head alternate in each round" : ""}.`,
		"",
		"Machines:",
		"",
		...machines,
		"",
		"</details>",
		"",
	].join("\n");
	return { markdown, slower };
}

function positiveInteger(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`--${name} must be a positive integer, not "${value}".`);
	}
	return parsed;
}

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		base: { type: "string" },
		json: { type: "string" },
		rounds: { type: "string", default: "3" },
		seconds: { type: "string", default: "5" },
		threshold: { type: "string", default: "10" },
	},
});
const threshold = positiveInteger(values.threshold, "threshold");

if (positionals[0] === "report") {
	const files = positionals.slice(1).map((file) => {
		const results: Results = JSON.parse(readFileSync(file, "utf8"));
		return results;
	});
	const { markdown, slower } = report(files, threshold);
	process.stdout.write(markdown);
	process.exitCode = slower ? 1 : 0;
} else {
	const runtimes = positionals.length > 0 ? positionals : Object.keys(commands);
	const unknown = runtimes.filter((runtime) => !(runtime in commands));
	if (unknown.length > 0) {
		throw new Error(`Unknown runtime: ${unknown.join(", ")}.`);
	}
	const rounds = positiveInteger(values.rounds, "rounds");
	const seconds = positiveInteger(values.seconds, "seconds");
	const sides: { side: Side; root: string }[] = [
		...(values.base == null ? [] : [{ side: "base" as const, root: resolvePath(values.base) }]),
		{ side: "head", root: packageDirectory },
	];
	for (const { root } of sides) {
		buildFixtures(root);
	}
	const samples: Sample[] = [];
	// Why this order: base and head of one route run one after the other, and the order flips in
	// each round.
	const runs = runtimes.flatMap((runtime) =>
		apps.flatMap((app) =>
			Array.from({ length: rounds }, (_, round) =>
				(Object.keys(routes) as Route[]).flatMap((route) =>
					(round % 2 === 0 ? sides : sides.toReversed()).map(({ side, root }) => ({
						runtime,
						app,
						route,
						side,
						root,
					})),
				),
			).flat(),
		),
	);
	for (const [index, { runtime, app, route, side, root }] of runs.entries()) {
		process.stderr.write(`[${index + 1}/${runs.length}] ${runtime} ${app.name} ${route} ${side}\n`);
		// oxlint-disable-next-line no-await-in-loop -- one server at a time, so the runs do not share the CPU.
		const sample = await measure(runtime, app, { route, side, root, seconds });
		if (sample?.outcome === "fails") {
			process.stderr.write(`${sample.reason}\n`);
		}
		if (sample != null) {
			samples.push(sample);
		}
	}
	const results: Results = {
		meta: {
			cpu: cpus()[0]?.model.trim() ?? "unknown CPU",
			cpus: cpuCount,
			platform: process.platform,
			pinned,
			rounds,
			seconds,
			connections,
			commits: Object.fromEntries(sides.map(({ side, root }) => [side, commit(root)])),
			versions: Object.fromEntries(runtimes.map((runtime) => [runtime, version(runtime)])),
		},
		samples,
	};
	if (values.json != null) {
		writeFileSync(values.json, `${JSON.stringify(results, null, "\t")}\n`);
	}
	process.stdout.write(report([results], threshold).markdown);
}
