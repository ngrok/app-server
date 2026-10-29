// A server build entry for `test/runtimes.ts`: the built package with a stub framework, so the
// same checks run on Node, Bun, and Deno.
import { fileURLToPath } from "node:url";
import { createServer, eventStream, tcp } from "../../dist/index.js";

const encoder = new TextEncoder();
const clientDirectory = fileURLToPath(new URL("client", import.meta.url));

let releaseStream = () => {};
let holdCancelled = false;

export const app = createServer({
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
	"/events": (request) =>
		eventStream({ signal: request.signal }, ({ send }) => {
			send({ data: "hello" });
			return new Promise(() => {});
		}),
};

export function appServerAdapter() {
	return {
		clientDirectory,
		prerenderedPaths: ["/cpu", "/gone"],
		fetch: async (request) => {
			const route = routes[new URL(request.url).pathname];
			return route == null
				? new Response("rendered", { headers: { "Content-Type": "text/html" } })
				: route(request);
		},
	};
}
