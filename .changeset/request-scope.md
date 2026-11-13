---
"@ngrok/app-server": minor
---

A request no longer stays in memory for the life of a timer that it leaves, and the lists of a request that the server owns leave the public types. Both changes break a type. The first is for a host adapter of your own, and the second is for a plugin that read or set one of three context keys. An app on the node host or the vercel host that uses neither changes nothing.

**A `RequestStore` holds a `RequestScope`, not the Hono context.** `RequestScope` is a new type export. A host passes it through and reads no field of it. TypeScript reports the old type. In JavaScript, a host needs no change.

```ts
// Before
import type { Context } from "hono";
import type { AppServerEnv } from "@ngrok/app-server";
const storage = new AsyncLocalStorage<Context<AppServerEnv>>();
// After
import type { RequestScope } from "@ngrok/app-server";
const storage = new AsyncLocalStorage<RequestScope>();
```

Why: Node.js keeps the stored value of the code that makes a timer until the timer fires. So a timer that a loader or an `entry.server` left, such as a render abort timer that the entry does not clear, kept the Hono context of its request, and with it Node's request and response, the `Response`, and each header hook. When the response is sent, the server now puts the request's values in the scope and lets go of the context.

- `requestContext()` and `logger()` give the same values in work that the request started, also after the response is sent. The lines of that logger then carry the request fields (`http.request_id`, `http.method`, `http.url_details.path`, and the trace IDs) that the request had when the response ended. A logger that the app set with `c.set("logger", …)` stays.
- On Bun and Deno, a request of a plugin list with no `accessLog()` keeps its context as before. Why: their listeners do not tell the server when a response ends, and the server puts a stream around the body to see that end only for the access log.

We measured a React Router page of the test fixture on the node host with the default plugins, on Node.js 26.13 and an Apple M3 Max, with the build before the change and the build after it in turn, 3 times each.

- Each request that left a 60 s timer kept 10,107 bytes of heap before and keeps 522 bytes now. With no request storage, the timer alone keeps 149 bytes. We sent 20,000 requests with `oha -c 16` and read `heapUsed` after two garbage collections.
- With a 6 s timer for each request and 60,000 requests at about 5,200 requests each second, the peak `heapUsed` goes from 711 to 748 MB down to 161 to 164 MB, and the peak resident set size (RSS) from 1,031 to 1,082 MB down to 413 to 430 MB. The time in minor garbage collections goes from 511 to 561 ms down to 291 to 366 ms.
- The time for each request does not change: 0.93 to 1.06 times the time before, for 60,000 requests in one process through the built pipeline, 11 interleaved rounds, 3 repeats, with no plugin, with the default plugins, and with a response edge as the node listener gives it.

The wrapper that runs each request in the request storage also makes one promise less for each request. In a micro benchmark of the wrapper alone, a call takes 307 ns, not 327 ns (15 interleaved rounds of 300,000 calls, 3 repeats). The time of a full request does not show it.

**`AppServerEnv["Variables"]` no longer has `etagParts`, `headerHooks`, and `sentReports`.** The server owns these lists. A plugin that set one of them replaced the list that the server reads: after `c.set("headerHooks", [])`, a rendered page lost `Cache-Control: private, no-cache`, and after `c.set("sentReports", [])`, the request got no access log line. TypeScript now reports a `c.get` or a `c.set` of the three keys. The server runs the same code as before, so a JavaScript plugin can still set them, and must not.

```ts
// Before
const frameOptions: Plugin = {
	name: "frame-options",
	middleware: async (c, next) => {
		c.get("headerHooks")?.push((headers) => {
			headers.set("X-Frame-Options", "DENY");
		});
		await next();
	},
};
// After
import { withHeaderHook } from "@ngrok/app-server";

const frameOptions: Plugin = {
	name: "frame-options",
	middleware: async (c, next) =>
		withHeaderHook(c, next, (headers) => {
			headers.set("X-Frame-Options", "DENY");
		}),
};
```

For a value in the ETag of each static file, give the plugin an `etagPart`, not a write to `etagParts`. `sentReports` has no replacement: the package exports no function that reports the end of a response.
