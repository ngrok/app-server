// A server build entry for `test/runtimes.ts`: the built package with a stub framework, so the
// same checks run on Node, Bun, and Deno.
import { join } from "node:path";
import {
	createEntry,
	createServer,
	defaultPlugins,
	eventStream,
	jsonSink,
	logger,
} from "../../dist/index.js";
import { host, tcp } from "../../dist/node.js";

const encoder = new TextEncoder();
const clientDirectory = join(import.meta.dirname, "client");

let releaseStream = () => {};
let holdCancelled = false;

const app = createServer({
	// Why the large line before `stopped`: it fills the stdout pipe just before the exit. The exit
	// must wait for the pipe, or the `stopped` line is lost.
	logger: jsonSink((line) => {
		if (line.includes('"message":"stopped"')) {
			process.stdout.write(`${"x".repeat(256 * 1024)}\n`);
		}
		process.stdout.write(line);
	}),
	listeners: [tcp({ port: 0, host: "127.0.0.1" })],
	plugins: defaultPlugins({
		bodyLimit: 1024,
		accessLog: {
			attributes: ({ sent }) => ({ "sent.request_id": sent.headers.get("X-Request-Id") }),
		},
	}),
	shutdownDeadlineMs: 3_000,
});
app.get("/hold-status", (context) => context.text(String(holdCancelled)));
app.get("/release", (context) => {
	releaseStream();
	return context.text("released");
});

const routes = {
	"/stream": () =>
		new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode("<html>shell"));
					releaseStream = () => {
						controller.enqueue(encoder.encode("rest</html>"));
						controller.close();
					};
				},
			}),
			{ headers: { "Content-Type": "text/html" } },
		),
	"/hold": () =>
		new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode("held"));
				},
				cancel() {
					holdCancelled = true;
				},
			}),
			{ headers: { "Content-Type": "text/html" } },
		),
	// A body that never ends and ignores `shutdownSignal()`, so only the drain deadline stops it.
	"/stuck": () =>
		new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode("stuck"));
				},
			}),
			{ headers: { "Content-Type": "text/plain" } },
		),
	// Answers after the drain deadline with a body that runs a timer until it is cancelled.
	"/late": async () => {
		await new Promise((resolve) => {
			setTimeout(resolve, 4_000);
		});
		let timer;
		return new Response(
			new ReadableStream({
				start(controller) {
					timer = setInterval(() => controller.enqueue(encoder.encode("tick")), 100);
				},
				cancel() {
					clearInterval(timer);
				},
			}),
			{ headers: { "Content-Type": "text/plain" } },
		);
	},
	// Leaves a timer that outlives the response, as React Router's render abort timer does.
	"/linger": () => {
		setTimeout(() => {}, 60_000);
		return new Response("lingering", { headers: { "Content-Type": "text/plain" } });
	},
	// Leaves a rejected promise with no handler, as a call that the route does not await can.
	"/reject": () => {
		void Promise.reject(new Error("no handler"));
		return new Response("rejected", { headers: { "Content-Type": "text/plain" } });
	},
	// Throws outside the request, as a callback of a timer or of an event emitter can.
	"/throw": () => {
		setTimeout(() => {
			throw new Error("thrown in a timer");
		}, 0);
		return new Response("thrown", { headers: { "Content-Type": "text/plain" } });
	},
	// A page of one chunk, which a pooled zlib stream compresses.
	"/page": () =>
		new Response("<p>page</p>".repeat(200), { headers: { "Content-Type": "text/html" } }),
	"/upload": async (request) => new Response(String((await request.arrayBuffer()).byteLength)),
	"/events": (request) =>
		eventStream(
			({ send }) => {
				send({ data: "hello" });
				return new Promise(() => {});
			},
			{ signal: request.signal },
		),
};

// An app's own listener for a rejected promise, as an error tracker adds. Why `once` before
// startup: on Bun, the listener removes itself before it runs, so the host must not count it then.
if (process.env.OWN_REJECTION_LISTENER === "1") {
	process.once("unhandledRejection", () => {
		logger().warn("the app got the rejection");
	});
}

// Why `createEntry`: the CLI calls this export, so this copy of the package runs the server.
export const appServer = createEntry({
	app,
	host,
	framework: () => ({
		name: "stub",
		clientDirectory,
		fetch: async (request) => {
			const route = routes[new URL(request.url).pathname];
			return route == null
				? new Response("rendered", { headers: { "Content-Type": "text/html" } })
				: route(request);
		},
	}),
});
