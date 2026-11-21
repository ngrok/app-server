import { createServer, defaultPlugins } from "@ngrok/app-server";
import { tcp } from "@ngrok/app-server/node";

/** The events that the sink got, for `test/browser.ts`. */
const events = [];

const app = createServer({
	listeners: [tcp({ port: 0, host: "127.0.0.1" })],
	shutdownDeadlineMs: 3_000,
	plugins: defaultPlugins({
		errors: {
			sink: (event) => {
				events.push(event);
			},
		},
	}),
});
app.get("/events", (context) => context.json(events));
export default app;
