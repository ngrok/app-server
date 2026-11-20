// Checks the client error reports in real browsers: Chromium, Firefox, and WebKit. Each browser
// writes a stack in its own format, and only a browser runs the inline script before the chunks of
// the app. Run `pnpm run build` and `pnpm exec playwright install chromium firefox webkit` first.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { chromium, firefox, webkit } from "playwright";
import type { BrowserType } from "playwright";
import { packageDirectory, startServer } from "./harness.ts";

const directory = join(import.meta.dirname, "fixtures/client-errors");
const browsers: Record<string, BrowserType> = { chromium, firefox, webkit };

/** One event of the fixture's sink: the fields that this check reads. */
type SinkEvent = {
	message: string;
	source: string;
	route?: string;
	path: string;
	buildId?: string;
	frames: { file: string; line: number; column: number }[];
};

/** What the sink must get for one page of the fixture. */
type Expected = { page: string; message: string; source: string; route?: string };

const pages: Expected[] = [
	// The client entry does not run on this page, so only the inline script can report.
	{ page: "/chunk", message: "chunk failed", source: "error" },
	// The error boundary of the router catches this error, so only the hooks can report.
	{ page: "/render/42", message: "render failed", source: "router", route: "/render/:id" },
	{ page: "/timer", message: "timer failed", source: "error" },
	{ page: "/rejection", message: "rejection failed", source: "unhandledrejection" },
];

/** The events that the sink of the fixture got. */
async function sinkEvents(base: string): Promise<SinkEvent[]> {
	const response = await fetch(new URL("/events", base));
	const events: SinkEvent[] = await response.json();
	return events;
}

/** Resolves with the event for `expected`, and fails when the sink does not get it in 10 seconds. */
async function eventFor(base: string, expected: Expected, name: string): Promise<SinkEvent> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		// oxlint-disable-next-line no-await-in-loop -- each read comes after the one before it.
		const event = (await sinkEvents(base)).find(({ message }) => message === expected.message);
		if (event != null) {
			return event;
		}
		assert.ok(Date.now() < deadline, `${name}: the sink got no "${expected.message}" event`);
		// oxlint-disable-next-line no-await-in-loop -- the wait between two reads.
		await new Promise((resolve) => {
			setTimeout(resolve, 100);
		});
	}
}

async function check(name: string, type: BrowserType, base: string): Promise<void> {
	const browser = await type.launch();
	try {
		// Why another user agent: headless Chromium names itself `HeadlessChrome`, and the plugin drops
		// the report of a headless browser.
		const probe = await browser.newPage();
		const userAgent = (await probe.evaluate(() => navigator.userAgent)).replace("Headless", "");
		await probe.close();
		const page = await browser.newPage({ userAgent });
		const posts: string[] = [];
		page.on("request", (request) => {
			if (request.method() === "POST") {
				posts.push(new URL(request.url()).pathname);
			}
		});
		for (const expected of pages) {
			// oxlint-disable-next-line no-await-in-loop -- one page at a time: the sink keeps each event by its message.
			await page.goto(new URL(expected.page, base).href);
			// oxlint-disable-next-line no-await-in-loop -- as above.
			const event = await eventFor(base, expected, name);
			assert.equal(event.source, expected.source, `${name} ${expected.page}: the source`);
			assert.equal(event.route, expected.route, `${name} ${expected.page}: the route pattern`);
			assert.equal(event.path, expected.page, `${name} ${expected.page}: the path of the page`);
			assert.match(
				event.frames[0]?.file ?? "",
				/\/assets\/[^/]+\.js$/u,
				`${name} ${expected.page}: the first frame is a chunk of the app`,
			);
			assert.ok(
				(event.frames[0]?.line ?? 0) > 0,
				`${name} ${expected.page}: the first frame has a line`,
			);
		}
		assert.deepEqual([...new Set(posts)], ["/_x"], `${name}: each report goes to the one path`);
		process.stdout.write(`ok ${name}\n`);
	} finally {
		await browser.close();
	}
}

execFileSync(join(packageDirectory, "node_modules/.bin/react-router"), ["build"], {
	cwd: directory,
	stdio: ["ignore", "ignore", "inherit"],
});
const selected = process.argv.slice(2);
for (const name of selected.length > 0 ? selected : Object.keys(browsers)) {
	const type = browsers[name];
	assert.ok(type != null, `no browser has the name ${name}`);
	// Why a server for each browser: the sink of the fixture keeps each event by its message.
	const { child, url } = startServer("node", [join(packageDirectory, "dist/cli.js"), "serve"], {
		cwd: directory,
		// Why: React Router logs an error for the icon that each browser asks for.
		stderr: "ignore",
	});
	try {
		// oxlint-disable-next-line no-await-in-loop -- one browser at a time, so a failure names its browser.
		await check(name, type, await url);
	} finally {
		child.kill("SIGTERM");
	}
}
