---
"@ngrok/app-server": minor
---

A request no longer stays in memory for the life of a timer that it leaves. One breaking change makes this possible. It is for a host adapter of your own. An app on the node host or the vercel host changes nothing.

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
- On Bun and Deno, a request with no `accessLog()` and no other `onResponseSent` report keeps its context as before. Why: their listeners do not tell the server when a response ends, and the server puts a stream around the body to see that end only for a report.

We measured a React Router page of the test fixture on the node host with the default plugins, on Node.js 26.13 and an Apple M3 Max, with the build before the change and the build after it in turn, 3 times each.

- Each request that left a 60 s timer kept 10,107 bytes of heap before and keeps 522 bytes now. With no request storage, the timer alone keeps 149 bytes. We sent 20,000 requests with `oha -c 16` and read `heapUsed` after two garbage collections.
- With a 6 s timer for each request and 60,000 requests at about 5,200 requests each second, the peak `heapUsed` goes from 711 to 748 MB down to 161 to 164 MB, and the peak resident set size (RSS) from 1,031 to 1,082 MB down to 413 to 430 MB. The time in minor garbage collections goes from 511 to 561 ms down to 291 to 366 ms.
- The time for each request does not change: 0.93 to 1.06 times the time before, for 60,000 requests in one process through the built pipeline, 11 interleaved rounds, 3 repeats, with no plugin, with the default plugins, and with a response edge as the node listener gives it.

The wrapper that runs each request in the request storage also makes one promise less for each request. In a micro benchmark of the wrapper alone, a call takes 307 ns, not 327 ns (15 interleaved rounds of 300,000 calls, 3 repeats). The time of a full request does not show it.
