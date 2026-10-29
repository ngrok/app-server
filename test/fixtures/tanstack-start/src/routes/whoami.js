import { createFileRoute } from "@tanstack/react-router";
import { requestContext } from "@ngrok/app-server";

// A server route that reads the request ID from the app server.
export const Route = createFileRoute("/whoami")({
	server: {
		handlers: {
			GET: ({ context }) =>
				Response.json({
					fromContext: context.appServer?.requestId,
					fromStorage: requestContext()?.requestId,
				}),
		},
	},
});
