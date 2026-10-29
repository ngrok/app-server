# @ngrok/app-server

A composable [Hono](https://hono.dev) app server for [React Router](https://reactrouter.com) framework apps. It replaces `@react-router/serve`, and it runs the same request pipeline in development and production, on Node, Bun, and Deno.

What it fixes in `@react-router/serve`:

- A prerendered page answers at its own URL with a 200, not a 301 to a trailing slash.
- A prerendered resource route (`llms.txt`, `sitemap.xml`, a JSON API file) and each `.data` file keep the headers their loader sent: `Content-Type`, `Cache-Control`, CORS.
- A streamed page under gzip reaches the client chunk by chunk.
- Each request gets one JSON log line in your format, static files included, and an `X-Request-Id`.
- Shutdown drains open requests with a deadline, and the keep-alive timeout outlasts the proxy's idle pool.

## Requirements

- Node.js 24+, Bun 1.3+, or Deno 2.9+
- React Router 8.5+ and Vite 8.3+

## Install

```sh
pnpm add -E @ngrok/app-server hono
```

## Set up

Add the Vite plugin next to `reactRouter()`:

```ts
// vite.config.ts
import { serverEntry } from "@ngrok/app-server/vite";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [reactRouter(), serverEntry("./server.ts")],
});
```

Write the server. Its default export is the app:

```ts
// server.ts
import { createServer, defaultPlugins } from "@ngrok/app-server";

const app = createServer({ plugins: defaultPlugins() });
app.get("/livez", (c) => c.text("ok"));
export default app;
```

Run it:

```json
{
	"scripts": {
		"start": "app-server dev",
		"serve": "app-server start"
	}
}
```

`serverEntry` bundles `server.ts` into `build/server/index.js` with the rest of the app, so the server gets its path aliases and the app's one copy of `react-router`. The file stays a valid React Router server build. `serverEntry()` with no argument uses the default plugins.

The build exports `appServer`, and the CLI calls it. So the copy of this package in the build runs the server, and the CLI's copy runs nothing. The CLI refuses a build from a version of this package with another entry protocol.

An app with no `serverEntry` also works: `app-server start` reads a plain React Router build and runs it with the CLI's copy and the default plugins. In that build, a route that calls `shutdownSignal()` or `eventStream()` must import the CLI's copy, so do not bundle `@ngrok/app-server` into it.

## Commands

- `app-server dev`: Vite in middleware mode inside the pipeline, with HMR on the same port. Each request loads the latest server build, so an edit to a route or to `server.ts` applies at once. The port is `PORT`, else Vite's `server.port`. The host is `HOST`, else Vite's `server.host`.
- `app-server start [build/server/index.js]`: production. Reads `PORT` (default 3000) and `HOST` (default every interface). Stops on `SIGTERM` or `SIGINT`.

On Bun, run `bun node_modules/@ngrok/app-server/dist/cli.js start`. On Deno, run `deno run --allow-net --allow-env --allow-read --allow-sys node_modules/@ngrok/app-server/dist/cli.js start`.

## The pipeline

`createServer` runs the plugins in list order, then the app's own Hono routes, then React Router. `defaultPlugins()` returns this order:

1. `requestId()`: reuses a valid incoming `X-Request-Id`, else makes a UUID, and echoes it.
2. `accessLog({ redactQuery })`: one line per request when the body ends, with Datadog standard attributes (`http.status_code`, `network.bytes_written`, `duration` in nanoseconds). Query values are `REDACTED` by default.
3. `streamingCompress()`: gzip that flushes after each chunk. It skips encoded, partial, and `no-transform` responses.
4. The `beforeStatic` plugins: they see every response, prerendered pages included. `runtimeEnv` and `buildId` go here.
5. `assets()`: `/assets/*` with a one-year immutable cache. A missing asset gets a plain 404. In development, Vite serves here.
6. `prerendered({ headers, rewrite })`: every file in `build/client`, with an ETag and a 304 for a matching `If-None-Match`. A directory answers with its `index.html`. Each file has one URL: `/a//b`, `/a/index.html`, and `/a%2Fb` go on to React Router. Dotfiles stay private, except `/.well-known/`. A path with no file goes on to React Router.

`defaultPlugins()` is a plain array, so you can filter it or splice into it. A plugin is Hono middleware plus optional hooks:

```ts
import type { Plugin } from "@ngrok/app-server";

const securityHeaders: Plugin = {
	name: "security-headers",
	middleware: async (c, next) => {
		await next();
		c.header("X-Frame-Options", "DENY"); // `c.header` also works on a response with immutable headers
	},
	setup: (info) => {}, // once, before the first request; a throw stops startup
	onShutdown: async () => {}, // at shutdown, while the listeners drain, up to the deadline
};
```

A plugin that changes a response with a value it reads at run time, as `runtimeEnv` and `buildId` do, returns that value from `etagPart`. The server adds it to the ETag of each static file that the request reaches after the plugin, so a 304 never keeps a response made with an old value.

```ts
const version: Plugin = {
	name: "version",
	etagPart: () => process.env.APP_VERSION,
	middleware: async (c, next) => {
		await next();
		c.header("X-App-Version", process.env.APP_VERSION);
	},
};
```

## Content negotiation

`rewrite` maps a request path to the file to serve. A rewritten path follows the same rules as a request path. This serves a prerendered markdown twin, such as `/components/button.md` for `/components/button`, to a client that asks for markdown:

```ts
import { readdirSync } from "node:fs";

const markdownPaths = new Set(
	readdirSync("build/client", { recursive: true, encoding: "utf8" })
		.filter((file) => file.endsWith(".md"))
		.map((file) => `/${file}`),
);
const twin = (path: string) => `${path.replace(/\/+$/, "") || "/index"}.md`;

// Why a plugin: one URL answers HTML or markdown, so a shared cache must key on `Accept`.
const varyOnAccept: Plugin = {
	name: "vary-on-accept",
	middleware: async (c, next) => {
		await next();
		if (markdownPaths.has(twin(c.req.path))) {
			c.header("Vary", "Accept", { append: true });
		}
	},
};

createServer({
	plugins: defaultPlugins({
		beforeStatic: [varyOnAccept],
		prerendered: {
			rewrite: (path, c) =>
				markdownPaths.has(twin(path)) && c.req.header("Accept")?.includes("text/markdown")
					? twin(path)
					: path,
		},
	}),
});
```

Parse the `Accept` quality values when a client can send `text/markdown;q=0`.

## Prerendered headers

During React Router's prerender pass, `serverEntry` records the response headers of each prerendered file that is not an HTML document into `build/client/.headers.json`, and `prerendered()` replays them. It leaves out `Set-Cookie`, `Vary`, and the headers of one transfer, such as `Content-Length`.

A document's headers are not recorded, because `entry.server` sets them for each request (a CSP nonce, the host). Set the headers of a prerendered page with the `headers` option or a plugin. For its CSP, use a `script-src` with the hash of each inline script, not a nonce. The prerender writes one nonce into the file, and every visitor can read it, so it protects nothing.

## Logs

Pass a sink to use your own format. Attribute names are flat and dotted:

```ts
createServer({
	logger: {
		log: (level, message, attributes) => mySlogger[level](message, attributes),
	},
});
```

The default is `jsonSink()`: one JSON object per line on stdout.

In a loader, read the request ID and a logger whose lines carry it:

```ts
import { appServerContext } from "@ngrok/app-server/react-router";

export async function loader({ context }: Route.LoaderArgs) {
	context.get(appServerContext).logger.info("loading");
}
```

## Environment

`runtimeEnv(schema)` validates the environment once, at startup, with any [Standard Schema](https://standardschema.dev) (zod, valibot, arktype). A bad value stops the server with a message that names it.

```ts
import { createServer, defaultPlugins, runtimeEnv } from "@ngrok/app-server";
import { z } from "zod";

export const env = runtimeEnv(
	z.object({ PUBLIC_API_URL: z.url(), SESSION_KEY: z.string().min(32) }),
);

export default createServer({ plugins: defaultPlugins({ beforeStatic: [env] }) });
```

The values whose names start with `PUBLIC_` go into each HTML document at serve time, prerendered pages included, so one build serves every environment. Read them in the browser:

```ts
const publicEnv = JSON.parse(document.getElementById("app-server-public-env")?.textContent ?? "{}");
```

## Long-lived responses

`eventStream()` makes a server-sent event response that sends a heartbeat every 15 s, stops when the client disconnects, and closes at shutdown so the drain does not wait for it:

```ts
import { eventStream } from "@ngrok/app-server";

export async function loader({ request }: Route.LoaderArgs) {
	return eventStream({ signal: request.signal }, async ({ send, signal }) => {
		for await (const update of watch({ signal })) {
			send({ event: "update", data: JSON.stringify(update) });
		}
	});
}
```

For other long work, stop on `shutdownSignal()`.

## Options

`createServer` takes:

- `plugins`: default `defaultPlugins()`.
- `logger`: default `jsonSink()`.
- `listeners`: default `[tcp()]`. A listener decides how connections arrive. `tcp()` uses `node:http`, `Bun.serve`, or `Deno.serve`.
- `trustForwardedProto`: read the scheme from `X-Forwarded-Proto`. Set it only behind a proxy that overwrites the header. Default `false`. For a build with no `server.ts`, set `TRUST_FORWARDED_PROTO=1`.
- `shutdownDeadlineMs`: default `10000`.

## Limits

- The build must serve at `/` (React Router `publicPath`).
- `serverEntry` does not support React Router `serverBundles`.
- On Deno, `Deno.serve` logs a notice about its legacy `request.signal` behavior.
