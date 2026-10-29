import { createFileRoute } from "@tanstack/react-router";

// A prerendered server route. The server replays these headers from the build.
export const Route = createFileRoute("/hello.txt")({
	server: {
		handlers: {
			GET: () =>
				new Response("hello", {
					headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "max-age=60" },
				}),
		},
	},
});
