import { createServer } from "@ngrok/app-server";
import { tcp } from "@ngrok/app-server/node";

const app = createServer({
	listeners: [tcp({ port: 0, host: "127.0.0.1" })],
	shutdownDeadlineMs: 3_000,
});
app.get("/ping", (context) => context.text("pong"));
export default app;
