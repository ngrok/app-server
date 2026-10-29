---
"@ngrok/app-server": minor
---

Add `@ngrok/app-server`, a composable Hono app server for React Router that replaces `@react-router/serve`. It runs the same request pipeline in development and production, on Node, Bun, and Deno.

- Serves each prerendered page at its own URL with a 200. `@react-router/serve` answers the same URL with a 301 to a trailing slash.
- Replays the headers of each prerendered resource route and `.data` file (`Content-Type`, `Cache-Control`, CORS). The `serverEntry` Vite plugin records them during the prerender pass into `build/client/.headers.json`.
- Gzips text responses and flushes after each chunk, so a streamed page shell or a server-sent event reaches the client at once.
- Writes one JSON access line per request, static files included, with Datadog standard attribute names and redacted query values. Pass your own log sink to use your own format.
- Gives each request an `X-Request-Id`, and passes the ID and a request logger to loaders through `appServerContext`.
- Validates the environment at startup with `runtimeEnv(schema)`, and writes the `PUBLIC_*` values into each HTML document at serve time. A plugin's `etagPart` goes into each static ETag, so a 304 never keeps an old value.
- Drains open requests at shutdown, with a deadline, and closes event streams from `eventStream()` so the drain does not wait for them. The keep-alive timeout is 95 s, above the ngrok edge's idle pool.
- Every feature is a plugin that an app can drop, replace, or reorder, and the app can add plain Hono routes. `prerendered({ rewrite })` lets an app negotiate content, such as a markdown twin of a page.
- The build exports `appServer`, and the CLI calls it, so one copy of the package runs the server.

Run it with `app-server dev` and `app-server start`. The README has the setup.
