// A server build entry for `test/runtimes.ts`: the built package with a stub framework, so the
// same checks run on Node, Bun, and Deno.
import { fileURLToPath } from "node:url";
import { createEntry, createServer, eventStream, jsonSink, tcp } from "../../dist/index.js";

const encoder = new TextEncoder();
const clientDirectory = fileURLToPath(new URL("client", import.meta.url));

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
	"/events": (request) =>
		eventStream({ signal: request.signal }, ({ send }) => {
			send({ data: "hello" });
			return new Promise(() => {});
		}),
};

// Why `createEntry`: the CLI calls this export, so this copy of the package runs the server.
export const appServer = createEntry({
	app,
	framework: () => ({
		clientDirectory,
		prerenderedPaths: ["/cpu", "/gone"],
		fetch: async (request) => {
			const route = routes[new URL(request.url).pathname];
			return route == null
				? new Response("rendered", { headers: { "Content-Type": "text/html" } })
				: route(request);
		},
	}),
});
